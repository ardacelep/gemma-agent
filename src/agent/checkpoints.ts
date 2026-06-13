import * as vscode from 'vscode';
import { resolveUri } from './tools';

const MAX_SNAPSHOT_BYTES = 1024 * 1024; // 1 MB per file

interface FileSnapshot {
  uri: vscode.Uri;
  relPath: string;
  existedBefore: boolean;
  content?: Uint8Array;
  tooLarge?: boolean;
}

/**
 * Pre-mutation snapshots for one agent run. First-write-wins: the snapshot
 * captures the state before the agent's FIRST write to each file, so a
 * restore returns the workspace to how it was before the run.
 * Held in memory only — not persisted across reloads.
 */
export class Checkpoint {
  readonly id = `cp-${Date.now()}`;
  readonly createdAt = Date.now();
  private readonly snapshots = new Map<string, FileSnapshot>();

  /** Snapshot a file before its first mutation in this run. Later calls are no-ops. */
  async snapshot(filePath: string): Promise<void> {
    let uri: vscode.Uri;
    try {
      uri = resolveUri(filePath);
    } catch {
      return; // outside the workspace — the tool itself will refuse it
    }
    if (this.snapshots.has(uri.fsPath)) return;

    const relPath = vscode.workspace.asRelativePath(uri);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > MAX_SNAPSHOT_BYTES) {
        this.snapshots.set(uri.fsPath, { uri, relPath, existedBefore: true, tooLarge: true });
        return;
      }
      const content = await vscode.workspace.fs.readFile(uri);
      this.snapshots.set(uri.fsPath, { uri, relPath, existedBefore: true, content });
    } catch {
      // File doesn't exist yet — undo means deleting it
      this.snapshots.set(uri.fsPath, { uri, relPath, existedBefore: false });
    }
  }

  get files(): string[] {
    return [...this.snapshots.values()].map((s) => s.relPath);
  }

  /** Write snapshots back; delete files the agent created. */
  async restore(): Promise<{ restored: string[]; failed: string[] }> {
    const restored: string[] = [];
    const failed: string[] = [];
    for (const snap of this.snapshots.values()) {
      try {
        if (!snap.existedBefore) {
          await vscode.workspace.fs.delete(snap.uri, { useTrash: false });
        } else if (snap.tooLarge || !snap.content) {
          failed.push(`${snap.relPath} (too large to snapshot)`);
          continue;
        } else {
          await vscode.workspace.fs.writeFile(snap.uri, snap.content);
        }
        restored.push(snap.relPath);
      } catch (err) {
        failed.push(`${snap.relPath} (${(err as Error).message})`);
      }
    }
    return { restored, failed };
  }
}
