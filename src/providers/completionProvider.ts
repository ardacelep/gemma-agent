import * as vscode from 'vscode';
import { ollamaGenerate } from '../llm/client';
import { clean, isCommentLine } from './completionClean';
import { StatusBarManager } from '../statusBar';

function buildPrompt(doc: vscode.TextDocument, position: vscode.Position): string {
  const lang = doc.languageId;
  const totalLines = doc.lineCount;

  // Prefix: up to 60 lines before cursor
  const prefixStart = Math.max(0, position.line - 60);
  const prefix = doc.getText(new vscode.Range(prefixStart, 0, position.line, position.character));

  // Suffix: up to 20 lines after cursor (so model knows what NOT to write)
  const suffixEnd = Math.min(totalLines, position.line + 20);
  const suffix = doc.getText(new vscode.Range(position.line, position.character, suffixEnd, 0)).trimEnd();

  if (suffix.trim()) {
    return (
      `Complete the code at [CURSOR]. Output ONLY the inserted text, no explanation.\n\n` +
      `\`\`\`${lang}\n${prefix}[CURSOR]${suffix}\n\`\`\``
    );
  }
  // No suffix — simpler prompt
  return `\`\`\`${lang}\n${prefix}`;
}

const SYSTEM =
  'You are a code completion AI. ' +
  'Output ONLY the raw text to insert at the cursor — no markdown fences, no explanations, no repetition of existing code. ' +
  'Keep the completion short: finish the current expression or at most one small block. ' +
  'Match the indentation of the surrounding code exactly.';

export class GemmaCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private activeRequest: AbortController | undefined;
  /** Resolver of a superseded request — must be settled so VS Code never waits forever. */
  private pendingResolve: ((value: vscode.InlineCompletionList | null) => void) | undefined;

  constructor(private readonly statusBar?: StatusBarManager) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    if (!cfg.get<boolean>('completionEnabled', true)) return null;

    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const lang = document.languageId;

    // Per-language toggle: exact language id → "*" wildcard → enabled
    const langMap = cfg.get<Record<string, boolean>>('completionLanguages', {});
    if (!(langMap[lang] ?? langMap['*'] ?? true)) return null;

    // Don't trigger on blank/whitespace-only prefix
    if (!linePrefix.trim()) return null;

    // Don't trigger if the user is just writing a comment
    if (isCommentLine(lang, linePrefix)) return null;

    // Don't trigger if only 1-2 meaningful chars typed (too early, noisy)
    if (linePrefix.trim().length < 3) return null;

    // Don't re-trigger immediately if invoked automatically (already showing)
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      // Let debounce handle it
    }

    return new Promise((resolve) => {
      // Settle the superseded request before replacing its debounce timer
      this.pendingResolve?.(null);
      this.pendingResolve = resolve;

      const finish = (value: vscode.InlineCompletionList | null) => {
        if (this.pendingResolve === resolve) this.pendingResolve = undefined;
        this.statusBar?.setBusy(false);
        resolve(value);
      };

      clearTimeout(this.debounceTimer);
      const debounceMs = cfg.get<number>('completionDebounceMs', 600);

      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) return finish(null);

        this.activeRequest?.abort();
        this.activeRequest = new AbortController();

        const completionModel = cfg.get<string>('completionModel', '') || undefined;
        this.statusBar?.setBusy(true);
        try {
          const prompt = buildPrompt(document, position);
          const maxTokens = cfg.get<number>('completionMaxTokens', 150);
          const raw = await ollamaGenerate({
            prompt,
            system: SYSTEM,
            maxTokens,
            model: completionModel,
            signal: this.activeRequest.signal,
          });

          if (token.isCancellationRequested || !raw.trim()) return finish(null);

          const completion = clean(raw, linePrefix, lang);
          if (!completion) return finish(null);

          // Reject if the completion looks like it's re-writing existing suffix
          const nextLineText = position.line + 1 < document.lineCount
            ? document.lineAt(position.line + 1).text.trim()
            : '';
          if (nextLineText && completion.includes(nextLineText)) return finish(null);

          const range = new vscode.Range(position, position);
          const items = [new vscode.InlineCompletionItem(completion, range)];

          // Optional alternatives (cycled with Alt+] / Alt+[). VS Code needs the
          // full list up front, so each extra suggestion is one more generation.
          const alternatives = Math.min(3, Math.max(1, cfg.get<number>('completionAlternatives', 1)));
          for (let n = 1; n < alternatives && !token.isCancellationRequested; n++) {
            try {
              const altRaw = await ollamaGenerate({
                prompt,
                system: SYSTEM,
                maxTokens,
                temperature: 0.8,
                model: completionModel,
                signal: this.activeRequest.signal,
              });
              const alt = clean(altRaw, linePrefix, lang);
              if (alt &&
                  !items.some((it) => it.insertText === alt) &&
                  !(nextLineText && alt.includes(nextLineText))) {
                items.push(new vscode.InlineCompletionItem(alt, range));
              }
            } catch {
              break;
            }
          }

          finish(new vscode.InlineCompletionList(items));
        } catch {
          finish(null);
        }
      }, debounceMs);

      token.onCancellationRequested(() => {
        clearTimeout(this.debounceTimer);
        this.activeRequest?.abort();
        finish(null);
      });
    });
  }

  dispose() {
    clearTimeout(this.debounceTimer);
    this.activeRequest?.abort();
    this.pendingResolve?.(null);
    this.pendingResolve = undefined;
  }
}
