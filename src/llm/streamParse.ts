// Pure incremental stream parsers (NDJSON + SSE). MUST NOT import vscode.
// Unit-tested for partial-line buffering across chunk boundaries.

/**
 * Accumulate a chunk into `buffer` and return any complete lines plus the
 * leftover partial line. CRLF-tolerant. Used for both NDJSON (Ollama) and
 * SSE (OpenAI-compatible) framing.
 */
export function feedLines(buffer: string, chunk: string): { lines: string[]; rest: string } {
  const combined = buffer + chunk;
  const parts = combined.split('\n');
  const rest = parts.pop() ?? '';
  const lines = parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  return { lines, rest };
}

/**
 * Interpret one SSE line. Only `data:` lines carry payloads; `data: [DONE]`
 * signals end of stream. Returns `{}` for comments/empty/other fields.
 */
export function parseSseLine(line: string): { data?: string; done?: boolean } {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('data:')) return {};
  const payload = trimmed.slice(5).trim();
  if (payload === '[DONE]') return { done: true };
  if (!payload) return {};
  return { data: payload };
}

/** Extract the content delta from one OpenAI-compatible SSE JSON payload. */
export function openAiDelta(jsonPayload: string): string | undefined {
  try {
    const obj = JSON.parse(jsonPayload) as { choices?: { delta?: { content?: string } }[] };
    return obj.choices?.[0]?.delta?.content;
  } catch {
    return undefined;
  }
}

/** Extract content + done from one Ollama NDJSON line. */
export function ollamaChatChunk(line: string): { content?: string; done?: boolean } {
  try {
    const obj = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
    return { content: obj.message?.content, done: obj.done };
  } catch {
    return {};
  }
}
