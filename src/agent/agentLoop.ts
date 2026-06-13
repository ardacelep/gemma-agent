import * as vscode from 'vscode';
import { OllamaMessage, ollamaChat } from '../ollama/client';
import { computeBudget, fitMessages } from '../ollama/contextWindow';
import { executeTool, TOOL_NAMES, ToolCall, ToolName } from './tools';

export const AGENT_SYSTEM_PROMPT = `You are an expert software development assistant with access to file system tools.

To use a tool, output EXACTLY this format — nothing else on the same response:
<tool_call>
{"tool":"<name>", ...args}
</tool_call>

Available tools:

create_file — Create or overwrite a file
{"tool":"create_file","path":"src/hello.ts","content":"console.log('hello')"}

edit_file — Replace exact text in a file (search must match exactly)
{"tool":"edit_file","path":"src/hello.ts","search":"old text","replace":"new text"}

read_file — Read file contents
{"tool":"read_file","path":"src/hello.ts"}

list_files — List directory contents
{"tool":"list_files","path":"src"}

search_files — Search for text across workspace files (set "regex":true for regex patterns)
{"tool":"search_files","query":"search term","path":"src"}

run_command — Run a shell command and capture its output
{"tool":"run_command","command":"npm install"}

get_diagnostics — Get compiler/linter errors and warnings (whole workspace, or one file via "path")
{"tool":"get_diagnostics","path":"src/hello.ts"}

Rules:
- When using a tool, output ONLY the <tool_call> block — no surrounding text.
- The tool call must be VALID JSON: escape newlines as \\n and double quotes as \\" inside string values.
- After receiving tool results, explain what you did and what happened.
- Use tools one at a time, sequentially.
- Always read a file before editing it to understand its current content.
- After editing files, call get_diagnostics to verify your changes did not introduce errors.
- Respond in the same language the user writes in.`;

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/;
// Fallback: some models emit the tool call as a fenced JSON block instead
const FENCED_TOOL_RE = /```(?:json)?\s*(\{[\s\S]*?"tool"[\s\S]*?\})\s*```/;

/** Hold back this many trailing chars per chunk so a partial '<tool_call' opener never flashes in the UI. */
const STREAM_HOLDBACK = 12;

/** Strip markdown link syntax from file paths: [name](url) → name */
function stripMarkdownLink(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
}

/**
 * Parse tool call JSON from model output.
 * Models frequently produce two kinds of broken JSON:
 *   1. Unescaped double-quotes inside string values (e.g. `"__main__"`)
 *   2. Literal newlines inside string values instead of \n
 * We try standard parse first, then two repair passes.
 */
function parseToolCall(raw: string): ToolCall {
  // Pass 1 — standard parse
  try {
    return sanitizeToolCall(JSON.parse(raw));
  } catch { /* continue */ }

  // Pass 2 — replace literal newlines inside the JSON text with \n
  //           (only inside string values, i.e. between " pairs)
  const fixed = raw.replace(/("(?:[^"\\]|\\.)*")/gs, (m) =>
    m.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
  );
  try {
    return sanitizeToolCall(JSON.parse(fixed));
  } catch { /* continue */ }

  // Pass 3 — extract fields individually with regex so the content field
  //           never breaks the parser (grab it as the remainder of the JSON)
  const tool = /"tool"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
  if (!tool) throw new Error('tool field not found');
  if (!(TOOL_NAMES as readonly string[]).includes(tool)) {
    throw new Error(`unknown tool "${tool}"`);
  }

  const result: Record<string, unknown> = { tool };

  for (const key of ['path', 'command', 'query']) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"`).exec(raw);
    if (m) result[key] = m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }

  // content — everything between `"content":` and the final `}`
  const contentStart = raw.indexOf('"content":');
  if (contentStart !== -1) {
    const afterKey = raw.slice(contentStart + 10).trimStart();
    if (afterKey.startsWith('"')) {
      // Grab until closing brace heuristically: strip leading quote and trailing "}
      let content = afterKey.slice(1);
      // Remove trailing `"}` or `" }` that closes the JSON object
      content = content.replace(/"\s*}?\s*$/, '');
      // Unescape sequences the model DID escape correctly
      content = content.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
      result['content'] = content;
    }
  }

  for (const key of ['search', 'replace']) {
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*?)"`).exec(raw);
    if (m) result[key] = m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
  }

  return sanitizeToolCall(result as ToolCall);
}

function sanitizeToolCall(call: ToolCall): ToolCall {
  // Strip markdown link syntax from path: [test.py](http://…) → test.py
  if (typeof call.path === 'string') call.path = stripMarkdownLink(call.path);
  if (typeof call.command === 'string') call.command = stripMarkdownLink(call.command);
  return call;
}

export interface AgentEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'warning' | 'agentThinking';
  text?: string;
  tool?: ToolCall;
  callId?: string;
  requiresApproval?: boolean;
  result?: { ok: boolean; output: string };
  iteration?: number;
  maxIterations?: number;
}

export interface AgentHooks {
  /** Ask the user before running a gated tool. Resolve 'deny' to skip it. */
  confirmTool?: (call: ToolCall, callId: string) => Promise<'approve' | 'deny'>;
  /** Called right before create_file / edit_file executes — used for undo snapshots. */
  beforeFileMutation?: (relPath: string) => Promise<void>;
}

type ApprovalMode = 'commands' | 'commandsAndWrites' | 'never';

function toolNeedsApproval(tool: ToolName, mode: ApprovalMode): boolean {
  if (mode === 'never') return false;
  if (tool === 'run_command') return true;
  if (mode === 'commandsAndWrites') return tool === 'create_file' || tool === 'edit_file';
  return false;
}

export async function* runAgentLoop(
  userMessage: string,
  history: OllamaMessage[],
  signal: AbortSignal,
  maxIterations = 10,
  hooks: AgentHooks = {}
): AsyncGenerator<AgentEvent> {
  // Strip markdown link syntax from user message so model doesn't copy it into paths
  const cleanedMessage = userMessage.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  const messages: OllamaMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: cleanedMessage },
  ];

  const cfg = vscode.workspace.getConfiguration('gemmaAgent');
  const budget = computeBudget(cfg.get<number>('numCtx', 8192), cfg.get<number>('maxTokens', 4096));
  const approvalMode = cfg.get<ApprovalMode>('agentRequireApproval', 'commands');

  for (let i = 0; i < maxIterations; i++) {
    if (signal.aborted) break;

    // Emit thinking indicator at the start of each iteration
    yield { type: 'agentThinking', iteration: i + 1, maxIterations };

    // The message array grows every iteration — trim a copy to fit the window
    const fitted = fitMessages(messages, budget).messages;

    // Collect model response, streaming text with a small holdback so a
    // partially-received '<tool_call' tag never leaks into the UI
    let raw = '';
    let emitted = 0;
    try {
      for await (const chunk of ollamaChat({ messages: fitted, signal })) {
        raw += chunk;
        if (!raw.includes('<tool_call>')) {
          const safeLen = Math.max(emitted, raw.length - STREAM_HOLDBACK);
          if (safeLen > emitted) {
            yield { type: 'text', text: raw.slice(emitted, safeLen) };
            emitted = safeLen;
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        yield { type: 'error', text: (err as Error).message };
      }
      break;
    }

    // Locate the tool call: <tool_call> tags first, fenced JSON as fallback
    const tagIdx = raw.indexOf('<tool_call>');
    const match = raw.match(TOOL_CALL_RE);
    let toolJson = match?.[1];
    if (!toolJson && tagIdx === -1) {
      toolJson = raw.match(FENCED_TOOL_RE)?.[1];
    }

    // Flush text that precedes the tool call (or all remaining text)
    const textEnd = tagIdx !== -1 ? tagIdx : raw.length;
    if (textEnd > emitted) {
      const rest = raw.slice(emitted, textEnd);
      if (rest.trim() || tagIdx === -1) yield { type: 'text', text: rest };
      emitted = textEnd;
    }

    if (!toolJson) {
      if (tagIdx !== -1) {
        // An opened but unparseable/unclosed tool call — ask the model to retry
        yield { type: 'warning', text: 'The tool call was malformed — asking the model to retry.' };
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content:
            'Your tool call was malformed or unclosed. Re-emit it as VALID JSON inside <tool_call></tool_call> tags, ' +
            'escaping newlines as \\n and double quotes as \\" inside string values.',
        });
        continue;
      }
      // No tool call — the agent is done
      yield { type: 'done' };
      return;
    }

    // Parse the tool call; on failure, feed the error back instead of dying
    let toolCall: ToolCall;
    try {
      toolCall = parseToolCall(toolJson);
    } catch (e) {
      yield { type: 'warning', text: `Could not parse tool call (${(e as Error).message}) — asking the model to retry.` };
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content:
          `Your tool call could not be parsed: ${(e as Error).message}. ` +
          'Re-emit it as VALID JSON inside <tool_call></tool_call> tags, ' +
          'escaping newlines as \\n and double quotes as \\" inside string values.',
      });
      continue;
    }

    const callId = `tc-${i}-${Date.now()}`;
    const needsApproval = toolNeedsApproval(toolCall.tool, approvalMode) && !!hooks.confirmTool;

    yield { type: 'tool_call', tool: toolCall, callId, requiresApproval: needsApproval };

    let decision: 'approve' | 'deny' = 'approve';
    if (needsApproval) {
      decision = await hooks.confirmTool!(toolCall, callId);
    }
    if (signal.aborted) break;

    if (decision === 'deny') {
      yield { type: 'tool_result', result: { ok: false, output: 'Denied by user.' }, callId };
      messages.push({ role: 'assistant', content: raw });
      messages.push({
        role: 'user',
        content: `Tool result (${toolCall.tool}): DENIED — the user declined to run this. Continue without it or propose an alternative.`,
      });
      continue;
    }

    // Snapshot files before mutating them so the user can undo the run
    if ((toolCall.tool === 'create_file' || toolCall.tool === 'edit_file') &&
        hooks.beforeFileMutation && typeof toolCall.path === 'string') {
      try {
        await hooks.beforeFileMutation(toolCall.path);
      } catch { /* snapshot failures must never block the tool */ }
    }

    const result = await executeTool(toolCall, signal);

    yield { type: 'tool_result', result, callId };

    // Feed result back into conversation
    messages.push({ role: 'assistant', content: raw });
    messages.push({
      role: 'user',
      content: `Tool result (${toolCall.tool}): ${result.ok ? 'SUCCESS' : 'ERROR'}\n${result.output}`,
    });
  }

  yield { type: 'done' };
}
