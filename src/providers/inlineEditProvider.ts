import * as vscode from 'vscode';
import { ollamaGenerate, isOllamaRunning } from '../ollama/client';

const GEMMA_SCHEME = 'gemma-proposed';

// Module-level registry for diff virtual document content
const proposedContents = new Map<string, string>();

// Provider registered once (lazy)
let diffProvider: vscode.Disposable | undefined;
function ensureDiffProvider(): void {
  if (diffProvider) return;
  diffProvider = vscode.workspace.registerTextDocumentContentProvider(GEMMA_SCHEME, {
    provideTextDocumentContent(uri: vscode.Uri): string {
      return proposedContents.get(uri.toString()) ?? '';
    },
  });
}

const SYSTEM = `You are an inline code editor. The user will give you a code snippet and an instruction.
Apply the instruction to the code and return ONLY the modified code.
Rules:
- Output raw code only — no markdown fences, no explanations, no comments about what changed.
- Preserve the EXACT original indentation style (spaces vs tabs, indentation depth).
- Preserve the language idioms and surrounding code style.
- If the instruction cannot be applied sensibly, return the original code unchanged.
- Do NOT add or remove blank lines at the start or end of the output unless the instruction requires it.`;

function buildPrompt(code: string, lang: string, instruction: string): string {
  return `Language: ${lang}
Instruction: ${instruction}

Code to edit:
\`\`\`${lang}
${code}
\`\`\`

Return only the edited code:`;
}

function extractCode(raw: string, lang: string): string {
  let text = raw.trim();
  // Strip fenced code block if model wrapped output
  const fenced = new RegExp(`^\`\`\`(?:${lang})?\\s*\\n?([\\s\\S]*?)\\n?\`\`\`\\s*$`, 'i');
  const match = text.match(fenced);
  if (match) return match[1];
  // Strip any opening/closing fences without language tag
  text = text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
  return text;
}

export async function inlineEdit(editor: vscode.TextEditor): Promise<void> {
  if (editor.selection.isEmpty) {
    vscode.window.showWarningMessage('Select code to edit first.');
    return;
  }

  if (!await isOllamaRunning()) {
    vscode.window.showErrorMessage('Ollama is not running. Run `ollama serve`.');
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: 'Gemma — Inline Edit',
    prompt: 'What should be done with this code?',
    placeHolder: 'e.g. "refactor", "convert to TypeScript", "fix errors", "make more efficient"',
    ignoreFocusOut: true,
  });
  if (!instruction) return;

  const originalSelection = editor.selection;
  const originalCode = editor.document.getText(originalSelection);
  const lang = editor.document.languageId;

  let proposed: string | undefined;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Gemma: "${instruction}"`,
      cancellable: true,
    },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());

      let result: string;
      try {
        result = await ollamaGenerate({
          prompt: buildPrompt(originalCode, lang, instruction),
          system: SYSTEM,
          maxTokens: 1024,
          signal: abort.signal,
        });
      } catch (err: unknown) {
        if ((err as Error).name !== 'AbortError') {
          vscode.window.showErrorMessage(`Gemma error: ${(err as Error).message}`);
        }
        return;
      }

      if (token.isCancellationRequested) return;

      proposed = extractCode(result, lang);
      if (!proposed || proposed === originalCode) {
        vscode.window.showInformationMessage('Gemma: No changes suggested.');
        proposed = undefined;
      }
    }
  );

  if (!proposed) return;

  // Show diff preview: original selection vs proposed
  ensureDiffProvider();

  const docUri = editor.document.uri;
  const virtualUri = vscode.Uri.from({
    scheme: GEMMA_SCHEME,
    path: docUri.path,
    query: `ts=${Date.now()}`,
  });

  proposedContents.set(virtualUri.toString(), proposed);

  // Build a full virtual document that replaces the selection with proposed
  const fullText = editor.document.getText();
  const startOffset = editor.document.offsetAt(originalSelection.start);
  const endOffset   = editor.document.offsetAt(originalSelection.end);
  const fullProposed = fullText.slice(0, startOffset) + proposed + fullText.slice(endOffset);

  const fullVirtualUri = vscode.Uri.from({
    scheme: GEMMA_SCHEME,
    path: docUri.path,
    query: `full_ts=${Date.now()}`,
  });
  proposedContents.set(fullVirtualUri.toString(), fullProposed);

  // Show diff of the full file (original vs proposed) so context is visible
  await vscode.commands.executeCommand(
    'vscode.diff',
    docUri,
    fullVirtualUri,
    `${vscode.workspace.asRelativePath(docUri)} ↔ Gemma Suggestion`,
    { preview: true, preserveFocus: false }
  );

  const action = await vscode.window.showInformationMessage(
    `Apply Gemma's suggestion for "${instruction}"?`,
    { modal: false },
    'Apply',
    'Discard'
  );

  // Cleanup virtual docs
  proposedContents.delete(virtualUri.toString());
  proposedContents.delete(fullVirtualUri.toString());

  // Close the diff editor
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  if (action !== 'Apply') return;

  // Apply using WorkspaceEdit for proper undo stack
  const we = new vscode.WorkspaceEdit();
  we.replace(docUri, originalSelection, proposed);
  const applied = await vscode.workspace.applyEdit(we);

  if (!applied) {
    vscode.window.showErrorMessage('Could not apply the edit.');
  }
}
