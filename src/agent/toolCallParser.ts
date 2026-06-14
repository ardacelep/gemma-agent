// Pure tool-call types + parser. MUST NOT import vscode so it stays unit-testable.

export const TOOL_NAMES = [
  'create_file',
  'edit_file',
  'read_file',
  'run_command',
  'list_files',
  'search_files',
  'get_diagnostics',
] as const;
export type ToolName = typeof TOOL_NAMES[number];

export interface ToolCall {
  tool: ToolName;
  [key: string]: unknown;
}

export const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/;
// Fallback: some models emit the tool call as a fenced JSON block instead
export const FENCED_TOOL_RE = /```(?:json)?\s*(\{[\s\S]*?"tool"[\s\S]*?\})\s*```/;

/**
 * JSON schema for one agent step: either a tool call or `{tool:"final", message}`.
 * Used to constrain generation (Ollama `format` / OpenAI `json_schema`) so the
 * model can't emit malformed/partial tool calls.
 */
export const TOOL_CALL_SCHEMA = {
  type: 'object',
  properties: {
    tool: { type: 'string', enum: [...TOOL_NAMES, 'final'] },
    path: { type: 'string' },
    content: { type: 'string' },
    search: { type: 'string' },
    replace: { type: 'string' },
    command: { type: 'string' },
    query: { type: 'string' },
    regex: { type: 'boolean' },
    message: { type: 'string', description: 'Final answer text when tool is "final".' },
  },
  required: ['tool'],
} as const;

/** Strip markdown link syntax from file paths: [name](url) → name */
export function stripMarkdownLink(s: string): string {
  return s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
}

/**
 * Parse tool call JSON from model output.
 * Models frequently produce two kinds of broken JSON:
 *   1. Unescaped double-quotes inside string values (e.g. `"__main__"`)
 *   2. Literal newlines inside string values instead of \n
 * We try standard parse first, then two repair passes.
 */
export function parseToolCall(raw: string): ToolCall {
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

export function sanitizeToolCall(call: ToolCall): ToolCall {
  // Strip markdown link syntax from path: [test.py](http://…) → test.py
  if (typeof call.path === 'string') call.path = stripMarkdownLink(call.path);
  if (typeof call.command === 'string') call.command = stripMarkdownLink(call.command);
  return call;
}
