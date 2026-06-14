import { asConnectionError, httpError } from './errors';
import { feedLines, ollamaChatChunk } from './streamParse';
import { ChatRequest, GenerateRequest, LlmCapabilities, LlmProvider, PullProgress } from './provider';

export class OllamaProvider implements LlmProvider {
  readonly kind = 'ollama' as const;
  readonly capabilities: LlmCapabilities = {
    canPull: true,
    canWarmup: true,
    canUnload: true,
    canStartStopServer: true,
    canListAvailable: true,
    canStructuredOutput: true,
  };

  constructor(readonly baseUrl: string) {}

  async *chat(req: ChatRequest): AsyncGenerator<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: req.signal,
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          ...(req.format ? { format: req.format } : {}),
          options: { num_predict: req.maxTokens, num_ctx: req.numCtx },
        }),
      });
    } catch (err) {
      throw asConnectionError(err);
    }
    if (!res.ok) throw await httpError(res, req.model ?? '');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const fed = feedLines(buf, decoder.decode(value, { stream: true }));
      buf = fed.rest;
      for (const line of fed.lines) {
        if (!line.trim()) continue;
        const { content, done: chunkDone } = ollamaChatChunk(line);
        if (content) yield content;
        if (chunkDone) return;
      }
    }
  }

  async generate(req: GenerateRequest): Promise<string> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: req.signal,
        body: JSON.stringify({
          model: req.model,
          prompt: req.prompt,
          ...(req.suffix !== undefined ? { suffix: req.suffix } : {}),
          system: req.system,
          stream: false,
          options: {
            num_predict: req.maxTokens,
            num_ctx: req.numCtx,
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          },
        }),
      });
    } catch (err) {
      throw asConnectionError(err);
    }
    if (!res.ok) throw await httpError(res, req.model ?? '');
    const data = (await res.json()) as { response: string };
    return data.response;
  }

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<Float32Array[]> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ model, input: texts }),
      });
    } catch (err) {
      throw asConnectionError(err);
    }
    if (!res.ok) throw await httpError(res, model);
    const data = (await res.json()) as { embeddings: number[][] };
    return (data.embeddings ?? []).map((v) => Float32Array.from(v));
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: { name: string }[] };
      return (data.models ?? []).map((m) => m.name);
    } catch {
      return [];
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async pull(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ model, stream: true }),
      });
    } catch (err) {
      throw asConnectionError(err);
    }
    if (!res.ok) throw await httpError(res, model);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const fed = feedLines(buf, decoder.decode(value, { stream: true }));
      buf = fed.rest;
      for (const line of fed.lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
          if (obj.error) throw new Error(obj.error);
          // Layer-relative percent (multiple layers each restart total/completed)
          const percent = obj.total && obj.completed
            ? Math.round((obj.completed / obj.total) * 100)
            : undefined;
          onProgress({ status: obj.status ?? 'downloading', percent });
        } catch (e) {
          if (e instanceof Error && e.message && !/JSON/.test(e.message)) throw e;
        }
      }
    }
  }

  async warmup(model: string, signal?: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: '5m', stream: false }),
        signal: signal ?? AbortSignal.timeout(90_000),
      });
    } catch (err) {
      throw asConnectionError(err);
    }
    if (!res.ok) throw await httpError(res, model);
  }

  async unload(model: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch { /* not loaded — nothing to do */ }
  }
}
