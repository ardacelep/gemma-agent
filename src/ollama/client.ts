import * as vscode from 'vscode';

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  prompt: string;
  system?: string;
  stream?: boolean;
  maxTokens?: number;
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
    model: cfg.get<string>('model', 'gemma3:4b'),
    maxTokens: cfg.get<number>('maxTokens', 512),
  };
}

export async function ollamaGenerate(opts: GenerateOptions): Promise<string> {
  const { baseUrl, model, maxTokens } = getConfig();
  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      model,
      prompt: opts.prompt,
      system: opts.system,
      stream: false,
      options: { num_predict: opts.maxTokens ?? maxTokens },
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { response: string };
  return data.response;
}

export async function* ollamaChat(opts: ChatOptions): AsyncGenerator<string> {
  const { baseUrl, model, maxTokens } = getConfig();
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: opts.signal,
    body: JSON.stringify({
      model,
      messages: opts.messages,
      stream: true,
      options: { num_predict: maxTokens },
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
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

/** Modeli RAM'den hemen boşalt. */
export async function unloadModel(model: string): Promise<void> {
  const { baseUrl } = getConfig();
  try {
    await fetch(`${baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch { /* zaten yüklü değilse sorun değil */ }
}

/** Modeli RAM'e önceden yükle (warm-up). */
export async function warmupModel(model: string, signal?: AbortSignal): Promise<void> {
  const { baseUrl } = getConfig();
  await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, keep_alive: '5m', stream: false }),
    signal: signal ?? AbortSignal.timeout(90_000),
  });
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
