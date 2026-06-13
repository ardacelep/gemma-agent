import * as vscode from 'vscode';

export const PREVIEW_SCHEME = 'gemma-preview';
const MAX_ENTRIES = 20;

/**
 * Serves virtual documents for diff previews (gemma-preview:// URIs).
 * Diff editors have no close event, so the backing map is a bounded FIFO —
 * an accepted, small leak.
 */
export class PreviewContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private seq = 0;

  static register(context: vscode.ExtensionContext): PreviewContentProvider {
    const provider = new PreviewContentProvider();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, provider)
    );
    return provider;
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  /** Store content and return a virtual URI. `label` ends with a basename so the diff picks the language. */
  make(content: string, label: string): vscode.Uri {
    const uri = vscode.Uri.parse(`${PREVIEW_SCHEME}:/${this.seq++}/${label}`);
    this.contents.set(uri.toString(), content);
    // FIFO eviction
    while (this.contents.size > MAX_ENTRIES) {
      const oldest = this.contents.keys().next().value;
      if (oldest === undefined) break;
      this.contents.delete(oldest);
    }
    return uri;
  }
}
