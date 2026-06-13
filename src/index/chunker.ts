// Pure indexing helpers: chunking, cosine similarity, top-k, vector codec.
// MUST NOT import vscode. Buffer (Node) is fine — used in the host and tests.

/** Files we never index/search. */
export const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|jar|class|exe|dll|so|dylib|woff2?|ttf|eot|mp[34]|mov|avi|bin|lock|min\.js|map)$/i;

export interface Chunk {
  startLine: number;
  endLine: number;
  text: string;
}

/** Split source into overlapping line windows. */
export function chunkSource(text: string, windowLines = 40, overlap = 10): Chunk[] {
  const lines = text.split('\n');
  if (lines.length === 0) return [];
  const step = Math.max(1, windowLines - overlap);
  const chunks: Chunk[] = [];
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(lines.length, start + windowLines);
    const slice = lines.slice(start, end).join('\n');
    if (slice.trim()) {
      chunks.push({ startLine: start + 1, endLine: end, text: slice });
    }
    if (end >= lines.length) break;
  }
  return chunks;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Indices of the top-k vectors by cosine similarity to `query`, with scores. */
export function topK<T extends { vector: Float32Array }>(
  query: Float32Array,
  items: T[],
  k: number
): Array<{ item: T; score: number }> {
  return items
    .map((item) => ({ item, score: cosine(query, item.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export function encodeVector(v: Float32Array): string {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64');
}

export function decodeVector(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  // Copy into an aligned buffer so Float32Array construction is always valid
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}
