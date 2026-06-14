import * as vscode from 'vscode';
import { OllamaMessage, getCapabilities, ollamaChat, resolveRoleModel } from '../llm/client';
import { computeBudget, fitMessages } from '../llm/contextWindow';
import { getInstructionSuffix } from '../llm/instructions';
import { executeTool, ToolCall, ToolName } from './tools';
import { FENCED_TOOL_RE, TOOL_CALL_RE, TOOL_CALL_SCHEMA, parseToolCall, sanitizeToolCall } from './toolCallParser';

/** Structured-mode system prompt — model returns ONE JSON object per step. */
export const AGENT_SYSTEM_PROMPT_STRUCTURED = `You are an expert software development assistant with file system tools.

Respond with EXACTLY ONE JSON object per turn — either a tool call or, when the task is complete, {"tool":"final","message":"<your answer>"}.

Tools and their fields:
- create_file: {"tool":"create_file","path":"src/x.ts","content":"..."}
- edit_file:   {"tool":"edit_file","path":"src/x.ts","search":"<exact existing text>","replace":"<new text>"}
- read_file:   {"tool":"read_file","path":"src/x.ts"}
- list_files:  {"tool":"list_files","path":"src"}
- search_files:{"tool":"search_files","query":"text","path":"src","regex":false}
- run_command: {"tool":"run_command","command":"npm test"}
- get_diagnostics: {"tool":"get_diagnostics","path":"src/x.ts"}

Rules:
- To change a file you MUST emit a tool call — describing a change in "message" does nothing.
- edit_file "search" must be the EXACT, COMPLETE existing text (read the file first). Never use "..." or placeholders.
- One tool at a time. After editing, call get_diagnostics to verify.
- Respond in the same language the user writes in (inside "message").`;

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
- NEVER claim you created, edited or ran something unless you ACTUALLY emitted a <tool_call> for it in this conversation. To change a file you MUST emit a tool call — describing the change in prose does nothing.
- For edit_file, "search" must be the EXACT, COMPLETE text from the file (read it first). Never use "...", placeholders, or abbreviations in "search" — partial text will not match.
- Use tools one at a time, sequentially.
- Always read a file before editing it to understand its current content.
- After editing files, call get_diagnostics to verify your changes did not introduce errors.
- Respond in the same language the user writes in.`;

/** Hold back this many trailing chars per chunk so a partial '<tool_call' opener never flashes in the UI. */
const STREAM_HOLDBACK = 12;

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

  const cfg = vscode.workspace.getConfiguration('gemmaAgent');
  const structured = cfg.get<boolean>('agentStructuredOutput', true) && getCapabilities().canStructuredOutput;
  const agentModel = resolveRoleModel('agent');

  const messages: OllamaMessage[] = [
    { role: 'system', content: (structured ? AGENT_SYSTEM_PROMPT_STRUCTURED : AGENT_SYSTEM_PROMPT) + getInstructionSuffix() },
    ...history,
    { role: 'user', content: cleanedMessage },
  ];

  const budget = computeBudget(cfg.get<number>('numCtx', 8192), cfg.get<number>('maxTokens', 4096));
  const approvalMode = cfg.get<ApprovalMode>('agentRequireApproval', 'commands');
  const autoVerify = cfg.get<boolean>('agentAutoVerify', true);

  let mutated = false;       // a create_file/edit_file succeeded this run
  let autoVerified = false;  // auto-verify has run at most once

  // Shared finalize: optionally auto-verify, then end the run.
  async function* finalize(i: number, raw: string, finalText?: string): AsyncGenerator<AgentEvent> {
    if (finalText && finalText.trim()) yield { type: 'text', text: finalText };
    if (autoVerify && mutated && !autoVerified && i < maxIterations - 1) {
      autoVerified = true;
      await new Promise((r) => setTimeout(r, 1000)); // let language servers catch up
      if (signal.aborted) { yield { type: 'done' }; return; }
      const verifyId = `tc-verify-${Date.now()}`;
      const verifyCall: ToolCall = { tool: 'get_diagnostics' };
      yield { type: 'tool_call', tool: verifyCall, callId: verifyId, requiresApproval: false };
      const verifyResult = await executeTool(verifyCall, signal);
      yield { type: 'tool_result', result: verifyResult, callId: verifyId };
      if (/\[Error\]/.test(verifyResult.output)) {
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'Automatic verification found these problems after your edits:\n' + verifyResult.output + '\nFix them, then finish.' });
        return; // caller continues the loop
      }
    }
    yield { type: 'done' };
  }

  for (let i = 0; i < maxIterations; i++) {
    if (signal.aborted) break;
    yield { type: 'agentThinking', iteration: i + 1, maxIterations };
    const fitted = fitMessages(messages, budget).messages;

    let toolCall: ToolCall | undefined;
    let raw = '';

    if (structured) {
      // ── Schema-constrained decision: one JSON object (tool call or final) ──
      try {
        for await (const chunk of ollamaChat({ messages: fitted, signal, model: agentModel, format: TOOL_CALL_SCHEMA })) raw += chunk;
      } catch (err) {
        if ((err as Error).name !== 'AbortError') yield { type: 'error', text: (err as Error).message };
        break;
      }
      let obj: { tool?: string; message?: string } | undefined;
      try { obj = JSON.parse(raw); } catch { obj = undefined; }
      if (!obj || typeof obj.tool !== 'string') {
        yield { type: 'warning', text: 'Model did not return a valid action — retrying.' };
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: 'Return exactly one JSON object matching the tool schema (a tool call, or {"tool":"final","message":...}).' });
        continue;
      }
      if (obj.tool === 'final') {
        let done = false;
        for await (const ev of finalize(i, raw, obj.message)) { yield ev; if (ev.type === 'done') done = true; }
        if (done) return; else continue;
      }
      toolCall = sanitizeToolCall(obj as ToolCall);
    } else {
      // ── Free-form streaming + parse (XML / fenced) with self-healing ──
      let emitted = 0;
      try {
        for await (const chunk of ollamaChat({ messages: fitted, signal, model: agentModel })) {
          raw += chunk;
          if (!raw.includes('<tool_call>')) {
            const safeLen = Math.max(emitted, raw.length - STREAM_HOLDBACK);
            if (safeLen > emitted) { yield { type: 'text', text: raw.slice(emitted, safeLen) }; emitted = safeLen; }
          }
        }
      } catch (err) {
        if ((err as Error).name !== 'AbortError') yield { type: 'error', text: (err as Error).message };
        break;
      }
      const tagIdx = raw.indexOf('<tool_call>');
      const match = raw.match(TOOL_CALL_RE);
      let toolJson = match?.[1];
      if (!toolJson && tagIdx === -1) toolJson = raw.match(FENCED_TOOL_RE)?.[1];
      const textEnd = tagIdx !== -1 ? tagIdx : raw.length;
      if (textEnd > emitted) {
        const rest = raw.slice(emitted, textEnd);
        if (rest.trim() || tagIdx === -1) yield { type: 'text', text: rest };
        emitted = textEnd;
      }
      if (!toolJson) {
        if (tagIdx !== -1) {
          yield { type: 'warning', text: 'The tool call was malformed — asking the model to retry.' };
          messages.push({ role: 'assistant', content: raw });
          messages.push({ role: 'user', content: 'Your tool call was malformed or unclosed. Re-emit it as VALID JSON inside <tool_call></tool_call> tags, escaping newlines as \\n and double quotes as \\" inside string values.' });
          continue;
        }
        let done = false;
        for await (const ev of finalize(i, raw)) { yield ev; if (ev.type === 'done') done = true; }
        if (done) return; else continue;
      }
      try {
        toolCall = parseToolCall(toolJson);
      } catch (e) {
        yield { type: 'warning', text: `Could not parse tool call (${(e as Error).message}) — asking the model to retry.` };
        messages.push({ role: 'assistant', content: raw });
        messages.push({ role: 'user', content: `Your tool call could not be parsed: ${(e as Error).message}. Re-emit it as VALID JSON inside <tool_call></tool_call> tags.` });
        continue;
      }
    }

    if (!toolCall) continue; // unreachable, but narrows the type for the tail
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
    if (result.ok && (toolCall.tool === 'create_file' || toolCall.tool === 'edit_file')) {
      mutated = true;
    }

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
