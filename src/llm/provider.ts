// Backend-agnostic LLM provider abstraction. vscode-free.

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCapabilities {
  /** Native model download (Ollama /api/pull). */
  canPull: boolean;
  /** Pre-load a model into RAM. */
  canWarmup: boolean;
  /** Evict a model from RAM. */
  canUnload: boolean;
  /** Start/stop the server process from the extension (Ollama app/CLI). */
  canStartStopServer: boolean;
  /** Offer a static catalog of downloadable models in the picker. */
  canListAvailable: boolean;
  /** Constrain generation to a JSON schema (Ollama format / OpenAI json_schema). */
  canStructuredOutput: boolean;
}

export interface ChatRequest {
  messages: OllamaMessage[];
  signal?: AbortSignal;
  model?: string;
  maxTokens?: number;
  numCtx?: number;
  /** JSON schema to constrain the output (only honored when canStructuredOutput). */
  format?: object;
  /** How long to keep the model warm in RAM (Ollama keep_alive, e.g. "30m"). */
  keepAlive?: string;
}

export interface GenerateRequest {
  prompt: string;
  system?: string;
  /** FIM suffix — server applies the model's fill-in-the-middle template. */
  suffix?: string;
  signal?: AbortSignal;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  numCtx?: number;
  keepAlive?: string;
}

export interface PullProgress {
  status: string;
  percent?: number;
}

export interface LlmProvider {
  readonly kind: 'ollama' | 'openai-compatible';
  readonly baseUrl: string;
  readonly capabilities: LlmCapabilities;

  chat(req: ChatRequest): AsyncGenerator<string>;
  generate(req: GenerateRequest): Promise<string>;
  embed(texts: string[], model: string, signal?: AbortSignal): Promise<Float32Array[]>;
  listModels(): Promise<string[]>;
  /** Health check: is the server reachable? */
  health(): Promise<boolean>;

  // Optional, capability-gated:
  pull?(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
  warmup?(model: string, signal?: AbortSignal): Promise<void>;
  unload?(model: string): Promise<void>;
}
