import { asConnectionError, httpError } from './errors';
import { feedLines, openAiDelta, parseSseLine } from './streamParse';
import { ChatRequest, GenerateRequest, LlmCapabilities, LlmProvider, OllamaMessage } from './provider';

/**
 * Works with any OpenAI-compatible local server: LM Studio (:1234),
 * Jan (:1337), llama.cpp llama-server (:8080), vLLM, LocalAI. No auth header
 * (local servers are keyless). Model management is the server's own concern.
 */
export class OpenAiCompatProvider implements LlmProvider {
  readonly kind = 'openai-compatible' as const;
  readonly capabilities: LlmCapabilities = {
    canPull: false,
    canWarmup: false,
    canUnload: false,
    canStartStopServer: false,
    canListAvailable: false,
    canStructuredOutput: true,
  };

  constructor(readonly baseUrl: string) {}

  private chatUrl(): string {
    // Tolerate users entering the base with or without /v1
    return this.baseUrl.replace(/\/+$/, '').endsWith('/v1')
      ? `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`
      : `${this.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`;
  }
  private apiBase(): string {
    const trimmed = this.baseUrl.replace(/\/+$/, '');
    return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
  }

  async *chat(req: ChatRequest): AsyncGenerator<string> {
    let res: Response;
    try {
      res = await fetch(this.chatUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: req.signal,
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          ...(req.format ? { response_format: { type: 'json_schema', json_schema: { name: 'tool_call', schema: req.format, strict: true } } } : {}),
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
        const { data, done: sseDone } = parseSseLine(line);
        if (sseDone) return;
        if (!data) continue;
        const delta = openAiDelta(data);
        if (delta) yield delta;
      }
    }
  }

  async generate(req: GenerateRequest): Promise<string> {
    // No reliable /v1/completions across servers — use chat with a system+user pair.
    const messages: OllamaMessage[] = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    messages.push({ role: 'user', content: req.prompt });

    let res: Response;
    try {
      res = await fetch(this.chatUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: req.signal,
        body: JSON.stringify({
          model: req.model,
          messages,
          stream: false,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        }),
      });
    } catch (err) {
      throw asConnectionError(err);
    }
    if (!res.ok) throw await httpError(res, req.model ?? '');
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? '';
  }

  async embed(texts: string[], model: string, signal?: AbortSignal): Promise<Float32Array[]> {
    let res: Response;
    try {
      res = await fetch(`${this.apiBase()}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({ model, input: texts }),
      });
    } catch (err) {
      throw asConnectionError(err);
    }
    if (!res.ok) throw await httpError(res, model);
    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    return (data.data ?? []).map((d) => Float32Array.from(d.embedding));
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.apiBase()}/models`);
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id: string }[] };
      return (data.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiBase()}/models`, { signal: AbortSignal.timeout(2000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}
