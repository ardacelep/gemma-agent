import * as vscode from 'vscode';

export const DEFAULT_MODEL = 'gemma4:e4b';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type OllamaErrorKind = 'connection' | 'model-not-found' | 'http' | 'timeout';

/** Typed error so callers can show precise, actionable messages. */
export class OllamaError extends Error {
  constructor(public readonly kind: OllamaErrorKind, message: string) {
    super(message);
    this.name = 'OllamaError';
  }
}

/** User-facing message for any error coming out of this client. */
export function describeOllamaError(err: unknown): string {
  if (err instanceof OllamaError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/** Map low-level fetch failures to OllamaError. AbortError passes through untouched. */
function asOllamaError(err: unknown): Error {
  const e = err as Error;
  if (e?.name === 'AbortError') return e;
  if (e?.name === 'TimeoutError') {
    return new OllamaError('timeout', 'Ollama request timed out.');
  }
  return new OllamaError(
    'connection',
    'Ollama is not running or unreachable. Start it from the chat panel or run `ollama serve`.'
  );
}

async function httpError(res: Response, model: string): Promise<OllamaError> {
  const body = await res.text().catch(() => '');
  if (res.status === 404 && /model/i.test(body)) {
    return new OllamaError(
      'model-not-found',
      `Model "${model}" is not installed. Pull it from the model picker or run \`ollama pull ${model}\`.`
    );
  }
  return new OllamaError('http', `Ollama returned HTTP ${res.status}: ${body.slice(0, 200)}`);
}

export interface GenerateOptions {
  prompt: string;
  system?: string;
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ChatOptions {
  messages: OllamaMessage[];
  stream?: boolean;
  signal?: AbortSignal;
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('gemmaAgent');
  return {
    baseUrl: cfg.get<string>('ollamaUrl', 'http://localhost:11434'),
    model: cfg.get<string>('model', DEFAULT_MODEL),
    maxTokens: cfg.get<number>('maxTokens', 4096),
    numCtx: cfg.get<number>('numCtx', 8192),
  };
}

export async function ollamaGenerate(opts: GenerateOptions): Promise<string> {
  const { baseUrl, model, maxTokens, numCtx } = getConfig();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: opts.signal,
      body: JSON.stringify({
        model,
        prompt: opts.prompt,
        system: opts.system,
        stream: false,
        options: {
          num_predict: opts.maxTokens ?? maxTokens,
          num_ctx: numCtx,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        },
      }),
    });
  } catch (err) {
    throw asOllamaError(err);
  }
  if (!res.ok) {
    throw await httpError(res, model);
  }
  const data = (await res.json()) as { response: string };
  return data.response;
}

export async function* ollamaChat(opts: ChatOptions): AsyncGenerator<string> {
  const { baseUrl, model, maxTokens, numCtx } = getConfig();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: opts.signal,
      body: JSON.stringify({
        model,
        messages: opts.messages,
        stream: true,
        options: { num_predict: maxTokens, num_ctx: numCtx },
      }),
    });
  } catch (err) {
    throw asOllamaError(err);
  }
  if (!res.ok) {
    throw await httpError(res, model);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
        if (chunk.message?.content) yield chunk.message.content;
        if (chunk.done) return;
      } catch {
        // malformed chunk — skip
      }
    }
  }
}

/** Evict the model from RAM immediately. */
export async function unloadModel(model: string): Promise<void> {
  const { baseUrl } = getConfig();
  try {
    await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* not loaded — nothing to do */ }
}

/** Pre-load the model into RAM (warm-up). */
export async function warmupModel(model: string, signal?: AbortSignal): Promise<void> {
  const { baseUrl } = getConfig();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: '5m', stream: false }),
      signal: signal ?? AbortSignal.timeout(90_000),
    });
  } catch (err) {
    throw asOllamaError(err);
  }
  if (!res.ok) {
    throw await httpError(res, model);
  }
}

export async function listModels(): Promise<string[]> {
  const { baseUrl } = getConfig();
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

export async function isOllamaRunning(): Promise<boolean> {
  const { baseUrl } = getConfig();
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}
