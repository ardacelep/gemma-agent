// Curated model registry — pure, vscode-free, unit-tested.
//
// ⚠ KEEP THIS CURRENT. Local models change monthly; this is a *starting point*
// that powers setup recommendations and FIM detection. Users can always run any
// model — nothing here is hardcoded into request paths beyond defaults.
// Snapshot reviewed: 2026-06.

export type ModelRole = 'chat' | 'agent' | 'completion' | 'embedding';
export type FimTemplate = 'qwen' | 'codegemma' | 'none';

export interface CatalogEntry {
  /** Ollama model id (what `ollama pull` takes). */
  id: string;
  roles: ModelRole[];
  /** Rough download size, for the UI. */
  sizeHint: string;
  /** Approx context window in K tokens. */
  contextK: number;
  /** FIM token family for completion, if any. */
  fim?: FimTemplate;
  /** Native/reliable tool-calling (affects agent suitability). */
  toolCalling?: boolean;
  note: string;
}

export const MODEL_CATALOG: CatalogEntry[] = [
  // ── chat / general ──────────────────────────────────────
  { id: 'gemma4:e4b', roles: ['chat'], sizeHint: '~3 GB', contextK: 8, note: 'Default — fast, capable general chat.' },
  { id: 'qwen3:8b', roles: ['chat', 'agent'], sizeHint: '~5 GB', contextK: 32, toolCalling: true, note: 'Strong general + agentic; good all-rounder.' },
  { id: 'gemma3:12b', roles: ['chat', 'agent'], sizeHint: '~8 GB', contextK: 32, note: 'Higher quality chat; needs more RAM.' },

  // ── agent / tool-calling / multi-file ───────────────────
  { id: 'qwen3-coder:30b', roles: ['agent', 'chat'], sizeHint: '~18 GB', contextK: 256, toolCalling: true, note: 'Top local coding agent — multi-file edits, tools.' },
  { id: 'devstral:24b', roles: ['agent'], sizeHint: '~14 GB', contextK: 128, toolCalling: true, note: 'Purpose-built for agentic coding / debugging loops.' },
  { id: 'qwen2.5-coder:7b', roles: ['agent', 'chat'], sizeHint: '~5 GB', contextK: 32, toolCalling: true, note: 'Solid coding agent on modest hardware.' },

  // ── completion (FIM) ────────────────────────────────────
  { id: 'qwen2.5-coder:1.5b-base', roles: ['completion'], sizeHint: '~1 GB', contextK: 32, fim: 'qwen', note: 'Recommended ghost-text model — small, fast, real FIM.' },
  { id: 'qwen2.5-coder:3b-base', roles: ['completion'], sizeHint: '~2 GB', contextK: 32, fim: 'qwen', note: 'Higher-quality FIM completion.' },
  { id: 'codegemma:2b', roles: ['completion'], sizeHint: '~1.6 GB', contextK: 8, fim: 'codegemma', note: 'Gemma-family FIM completion.' },

  // ── embedding (@workspace) ──────────────────────────────
  { id: 'nomic-embed-text', roles: ['embedding'], sizeHint: '~280 MB', contextK: 8, note: 'Default workspace-search embeddings.' },
  { id: 'embeddinggemma', roles: ['embedding'], sizeHint: '~620 MB', contextK: 8, note: 'Gemma-family embeddings.' },
];

export function recommendedFor(role: ModelRole): CatalogEntry[] {
  return MODEL_CATALOG.filter((e) => e.roles.includes(role));
}

/** Best single suggestion for a role (first catalog entry for it). */
export function defaultSuggestionFor(role: ModelRole): string | undefined {
  return recommendedFor(role)[0]?.id;
}

/**
 * Which FIM token family a completion model uses. Catalog first, then a
 * name-pattern fallback so newer tags (e.g. qwen2.5-coder:14b-base) still work.
 */
export function fimTemplateFor(modelId: string): FimTemplate {
  if (!modelId) return 'none';
  const hit = MODEL_CATALOG.find((e) => e.id === modelId);
  if (hit?.fim) return hit.fim;
  const id = modelId.toLowerCase();
  if (/qwen.*coder|codeqwen/.test(id)) return 'qwen';
  if (/codegemma/.test(id)) return 'codegemma';
  if (/deepseek-coder|starcoder|codellama|codestral/.test(id)) return 'qwen'; // these use <|fim_*|>-style infilling Ollama handles via suffix
  return 'none';
}

/** Does this model name look like a code/coder model (for completion suitability)? */
export function looksLikeCoderModel(modelId: string): boolean {
  return /coder|code|deepseek-coder|starcoder|codellama|codestral|devstral/i.test(modelId || '');
}
