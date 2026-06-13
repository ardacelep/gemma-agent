import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { ollamaEmbed } from '../llm/client';
import { BINARY_EXT, Chunk, chunkSource, decodeVector, encodeVector, topK } from './chunker';

const INDEX_FILE = 'workspace-index.json';
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CHUNKS = 2000;
const BATCH = 16;
const EXCLUDE = '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**}';

interface StoredChunk { startLine: number; endLine: number; vector: string }
interface FileEntry { hash: string; chunks: StoredChunk[] }
interface IndexFile { version: 1; model: string; files: Record<string, FileEntry> }

interface LiveChunk { path: string; startLine: number; endLine: number; vector: Float32Array }

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score: number;
}

export type IndexStatus = 'none' | 'building' | 'ready';

export class WorkspaceIndex {
  status: IndexStatus = 'none';
  private index?: IndexFile;
  private live?: LiveChunk[];

  constructor(private readonly context: vscode.ExtensionContext) {}

  private get storageFile(): vscode.Uri | undefined {
    if (!this.context.storageUri) return undefined;
    return vscode.Uri.joinPath(this.context.storageUri, INDEX_FILE);
  }

  private model(): string {
    return vscode.workspace.getConfiguration('gemmaAgent').get<string>('embeddingModel', 'nomic-embed-text');
  }

  /** Load a persisted index lazily; mark stale if the embedding model changed. */
  private async ensureLoaded(): Promise<void> {
    if (this.index || this.status === 'building') return;
    const file = this.storageFile;
    if (!file) return;
    try {
      const bytes = await vscode.workspace.fs.readFile(file);
      const parsed = JSON.parse(Buffer.from(bytes).toString('utf-8')) as IndexFile;
      if (parsed.version === 1 && parsed.model === this.model()) {
        this.index = parsed;
        this.rebuildLive();
        this.status = 'ready';
      }
    } catch { /* no index yet */ }
  }

  private rebuildLive(): void {
    this.live = [];
    if (!this.index) return;
    for (const [path, entry] of Object.entries(this.index.files)) {
      for (const c of entry.chunks) {
        this.live.push({ path, startLine: c.startLine, endLine: c.endLine, vector: decodeVector(c.vector) });
      }
    }
  }

  private async persist(): Promise<void> {
    const file = this.storageFile;
    if (!file || !this.index) return;
    await vscode.workspace.fs.createDirectory(this.context.storageUri!);
    await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(this.index), 'utf-8'));
  }

  /** Full (re)build over the workspace, cancellable, with progress. */
  async build(token: vscode.CancellationToken, progress: vscode.Progress<{ message?: string; increment?: number }>): Promise<void> {
    this.status = 'building';
    const model = this.model();
    const index: IndexFile = { version: 1, model, files: {} };

    const uris = await vscode.workspace.findFiles('**/*', EXCLUDE, 5000);
    const files = uris.filter((u) => !BINARY_EXT.test(u.path));
    let chunkCount = 0;

    for (let i = 0; i < files.length; i++) {
      if (token.isCancellationRequested) break;
      if (chunkCount >= MAX_CHUNKS) break;
      const uri = files[i];
      const rel = vscode.workspace.asRelativePath(uri);
      progress.report({ message: `Indexing ${rel}`, increment: 100 / files.length });
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_FILE_BYTES) continue;
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
        const chunks = chunkSource(text).slice(0, MAX_CHUNKS - chunkCount);
        if (chunks.length === 0) continue;
        const entry = await this.embedChunks(text, chunks, token);
        if (entry) { index.files[rel] = entry; chunkCount += entry.chunks.length; }
      } catch { /* skip unreadable */ }
    }

    if (token.isCancellationRequested) { this.status = this.index ? 'ready' : 'none'; return; }
    this.index = index;
    this.rebuildLive();
    this.status = 'ready';
    await this.persist();
  }

  private async embedChunks(fullText: string, chunks: Chunk[], token: vscode.CancellationToken): Promise<FileEntry | undefined> {
    const stored: StoredChunk[] = [];
    for (let b = 0; b < chunks.length; b += BATCH) {
      if (token.isCancellationRequested) return undefined;
      const batch = chunks.slice(b, b + BATCH);
      const vectors = await ollamaEmbed(batch.map((c) => c.text));
      batch.forEach((c, j) => {
        const v = vectors[j];
        if (v) stored.push({ startLine: c.startLine, endLine: c.endLine, vector: encodeVector(v) });
      });
    }
    return { hash: sha1(fullText), chunks: stored };
  }

  /** Incrementally re-index a single saved file (hash-gated). */
  async updateFile(uri: vscode.Uri): Promise<void> {
    if (this.status !== 'ready' || !this.index) return;
    if (BINARY_EXT.test(uri.path)) return;
    const rel = vscode.workspace.asRelativePath(uri);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_FILE_BYTES) return;
      const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
      const hash = sha1(text);
      if (this.index.files[rel]?.hash === hash) return; // unchanged
      const noop = new vscode.CancellationTokenSource().token;
      const entry = await this.embedChunks(text, chunkSource(text), noop);
      if (entry) {
        this.index.files[rel] = entry;
        this.rebuildLive();
        await this.persist();
      }
    } catch { /* ignore */ }
  }

  /** Semantic search; empty result if no index. */
  async query(text: string, k = 8): Promise<SearchHit[]> {
    await this.ensureLoaded();
    if (this.status !== 'ready' || !this.live || this.live.length === 0) return [];
    const [qv] = await ollamaEmbed([text]);
    if (!qv) return [];
    const hits = topK(qv, this.live, k);
    const out: SearchHit[] = [];
    for (const { item, score } of hits) {
      const snippet = await this.readSnippet(item.path, item.startLine, item.endLine);
      out.push({ path: item.path, startLine: item.startLine, endLine: item.endLine, snippet, score });
    }
    return out;
  }

  private async readSnippet(rel: string, startLine: number, endLine: number): Promise<string> {
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) return '';
      const text = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, rel))).toString('utf-8');
      return text.split('\n').slice(startLine - 1, endLine).join('\n').slice(0, 1500);
    } catch {
      return '';
    }
  }
}

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}
