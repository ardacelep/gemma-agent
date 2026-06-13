// Pure completion post-processing. MUST NOT import vscode (kept unit-testable).

export const COMMENT_STARTERS: Record<string, string[]> = {
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

export function isCommentLine(lang: string, prefix: string): boolean {
  const starters = COMMENT_STARTERS[lang] ?? [];
  const trimmed = prefix.trimStart();
  return starters.some((s) => trimmed.startsWith(s));
}

export function clean(raw: string, linePrefix: string, _lang: string): string {
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
    // Only cut if what follows the blank line looks like prose (no code-like characters)
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
