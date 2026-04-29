import * as vscode from 'vscode';
import { ollamaGenerate } from '../ollama/client';

const COMMENT_STARTERS: Record<string, string[]> = {
  python:        ['#'],
  javascript:    ['//', '/*', '*'],
  typescript:    ['//', '/*', '*'],
  javascriptreact: ['//', '/*', '*'],
  typescriptreact: ['//', '/*', '*'],
  java:          ['//', '/*', '*'],
  kotlin:        ['//', '/*', '*'],
  scala:         ['//', '/*', '*'],
  c:             ['//', '/*', '*', '#'],
  cpp:           ['//', '/*', '*', '#'],
  cuda:          ['//', '/*', '*', '#'],
  csharp:        ['//', '/*', '*'],
  rust:          ['//', '/*'],
  go:            ['//', '/*'],
  swift:         ['//', '/*', '*'],
  ruby:          ['#'],
  shellscript:   ['#'],
  bash:          ['#'],
  powershell:    ['#'],
  perl:          ['#'],
  r:             ['#'],
  lua:           ['--'],
  sql:           ['--', '/*', '*'],
};

function isCommentLine(lang: string, prefix: string): boolean {
  const starters = COMMENT_STARTERS[lang] ?? [];
  const trimmed = prefix.trimStart();
  return starters.some((s) => trimmed.startsWith(s));
}

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

function clean(raw: string, linePrefix: string, lang: string): string {
  let text = raw;

  // Strip markdown fences the model may have wrapped output in
  text = text.replace(/^```[\w]*\n?/, '').replace(/\n?```[\s\S]*$/, '');

  // Strip [CURSOR] if model echoed it
  text = text.replace(/\[CURSOR\]/g, '');

  text = text.trim();

  // Strip if model echoed the last non-empty line of our prefix
  const lastPrefixLine = linePrefix.trimStart();
  if (lastPrefixLine && text.startsWith(lastPrefixLine)) {
    text = text.slice(lastPrefixLine.length);
  }

  // Cut after first blank line only if the completion is multi-paragraph (looks like explanation)
  // Single-statement completions (e.g. one-liners) should not be cut
  const blankLine = text.indexOf('\n\n');
  if (blankLine !== -1) {
    const before = text.slice(0, blankLine);
    // Only cut if the first paragraph is more than one line (real code block) or
    // if what follows the blank line looks like prose (no code-like characters)
    const afterBlank = text.slice(blankLine + 2).trimStart();
    const looksLikeProse = /^[A-Z][a-z]/.test(afterBlank);
    if (looksLikeProse) {
      text = before;
    }
  }

  // Strip conversational filler
  text = text.replace(/^(here is|sure|of course|certainly|i'll|let me)[^:]*:?\s*/i, '');

  // Strip trailing blank lines only (not comment lines — they may be valid)
  const lines = text.split('\n');
  while (lines.length > 1 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  text = lines.join('\n');

  return text.trimEnd();
}

export class GemmaCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private activeRequest: AbortController | undefined;

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
      clearTimeout(this.debounceTimer);
      const debounceMs = cfg.get<number>('completionDebounceMs', 700);

      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) return resolve(null);

        this.activeRequest?.abort();
        this.activeRequest = new AbortController();

        try {
          const prompt = buildPrompt(document, position);
          const maxTokens = cfg.get<number>('completionMaxTokens', 150);
          const raw = await ollamaGenerate({
            prompt,
            system: SYSTEM,
            maxTokens,
            signal: this.activeRequest.signal,
          });

          if (token.isCancellationRequested || !raw.trim()) return resolve(null);

          const completion = clean(raw, linePrefix, lang);
          if (!completion) return resolve(null);

          // Reject if the completion looks like it's re-writing existing suffix
          const nextLineText = position.line + 1 < document.lineCount
            ? document.lineAt(position.line + 1).text.trim()
            : '';
          if (nextLineText && completion.includes(nextLineText)) return resolve(null);

          resolve(new vscode.InlineCompletionList([
            new vscode.InlineCompletionItem(
              completion,
              new vscode.Range(position, position)
            ),
          ]));
        } catch {
          resolve(null);
        }
      }, debounceMs);

      token.onCancellationRequested(() => {
        clearTimeout(this.debounceTimer);
        this.activeRequest?.abort();
        resolve(null);
      });
    });
  }

  dispose() {
    clearTimeout(this.debounceTimer);
    this.activeRequest?.abort();
  }
}
