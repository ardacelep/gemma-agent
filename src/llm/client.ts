import * as vscode from 'vscode';
import { LlmCapabilities, LlmProvider, OllamaMessage, PullProgress } from './provider';
import { OllamaProvider } from './ollamaProvider';
import { OpenAiCompatProvider } from './openaiCompatProvider';

export const DEFAULT_MODEL = 'gemma4:e4b';

// Re-export shared types/errors so existing importers keep working
export { OllamaMessage, LlmCapabilities, PullProgress };
export { OllamaError, describeOllamaError } from './errors';
export type { OllamaErrorKind } from './errors';

export type ApiProtocol = 'ollama' | 'openai-compatible';

export interface GenerateOptions {
  prompt: string;
  system?: string;
  stream?: boolean;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  model?: string;
}

export interface ChatOptions {
  messages: OllamaMessage[];
  stream?: boolean;
  signal?: AbortSignal;
  model?: string;
}

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('gemmaAgent');
  return {
    protocol: cfg.get<ApiProtocol>('apiProtocol', 'ollama'),
    baseUrl: cfg.get<string>('ollamaUrl', 'http://localhost:11434'),
    model: cfg.get<string>('model', DEFAULT_MODEL),
    completionModel: cfg.get<string>('completionModel', ''),
    maxTokens: cfg.get<number>('maxTokens', 4096),
    numCtx: cfg.get<number>('numCtx', 8192),
    embeddingModel: cfg.get<string>('embeddingModel', 'nomic-embed-text'),
  };
}

/** Build a provider from current config. Cheap — just stores a base URL. */
export function getProvider(): LlmProvider {
  const { protocol, baseUrl } = getConfig();
  return protocol === 'openai-compatible'
    ? new OpenAiCompatProvider(baseUrl)
    : new OllamaProvider(baseUrl);
}

export function getCapabilities(): LlmCapabilities {
  return getProvider().capabilities;
}

export function getApiProtocol(): ApiProtocol {
  return getConfig().protocol;
}

export async function* ollamaChat(opts: ChatOptions): AsyncGenerator<string> {
  const { model, maxTokens, numCtx } = getConfig();
  yield* getProvider().chat({
    messages: opts.messages,
    signal: opts.signal,
    model: opts.model ?? model,
    maxTokens,
    numCtx,
  });
}

export async function ollamaGenerate(opts: GenerateOptions): Promise<string> {
  const { model, maxTokens, numCtx } = getConfig();
  return getProvider().generate({
    prompt: opts.prompt,
    system: opts.system,
    signal: opts.signal,
    model: opts.model ?? model,
    maxTokens: opts.maxTokens ?? maxTokens,
    temperature: opts.temperature,
    numCtx,
  });
}

export async function ollamaEmbed(texts: string[], model?: string, signal?: AbortSignal): Promise<Float32Array[]> {
  const { embeddingModel } = getConfig();
  return getProvider().embed(texts, model ?? embeddingModel, signal);
}

export async function pullModelStream(
  model: string,
  onProgress: (p: PullProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  const provider = getProvider();
  if (!provider.pull) throw new Error('This backend does not support pulling models.');
  await provider.pull(model, onProgress, signal);
}

export async function unloadModel(model: string): Promise<void> {
  await getProvider().unload?.(model);
}

export async function warmupModel(model: string, signal?: AbortSignal): Promise<void> {
  await getProvider().warmup?.(model, signal);
}

export async function listModels(): Promise<string[]> {
  return getProvider().listModels();
}

export async function isOllamaRunning(): Promise<boolean> {
  return getProvider().health();
}
