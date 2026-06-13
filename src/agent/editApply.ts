// Pure edit-application logic shared by the edit_file tool and the diff
// preview, so the preview can never diverge from what actually gets written.
// MUST NOT import vscode.

export interface ApplyResult {
  ok: boolean;
  content?: string;
  error?: string;
}

/**
 * Apply a single exact-text replace, normalizing CRLF so Windows files match.
 * Mirrors the behavior of the edit_file tool.
 */
export function applyEdit(original: string, search: string, replace: string): ApplyResult {
  if (search === undefined) return { ok: false, error: 'search text not specified' };

  const normalizedOriginal = original.replace(/\r\n/g, '\n');
  const normalizedSearch = search.replace(/\r\n/g, '\n');
  const normalizedReplace = (replace ?? '').replace(/\r\n/g, '\n');

  if (!normalizedOriginal.includes(normalizedSearch)) {
    const snippet = normalizedSearch.length > 80 ? normalizedSearch.slice(0, 80) + '…' : normalizedSearch;
    return { ok: false, error: `Text not found:\n  "${snippet}"` };
  }

  return { ok: true, content: normalizedOriginal.replace(normalizedSearch, normalizedReplace) };
}
