import * as vscode from 'vscode';
import { ollamaGenerate } from '../ollama/client';
import { isOllamaRunning } from '../ollama/client';

const SYSTEM = `You are an inline code editor. The user will give you a code snippet and an instruction.
Apply the instruction to the code and return ONLY the modified code.
Rules:
- Output raw code only — no markdown fences, no explanations, no comments about what changed.
- Preserve the original indentation style and language.
- If the instruction cannot be applied sensibly, return the original code unchanged.`;

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
    vscode.window.showWarningMessage('Düzenlemek için önce kod seçin.');
    return;
  }

  if (!await isOllamaRunning()) {
    vscode.window.showErrorMessage('Ollama çalışmıyor. `ollama serve` komutunu çalıştırın.');
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: 'Gemma — Inline Düzenle',
    prompt: 'Bu koda ne yapalım?',
    placeHolder: 'örn. "refactor et", "TypeScript\'e çevir", "hataları düzelt", "daha verimli yap"',
    ignoreFocusOut: true,
  });
  if (!instruction) return;

  const originalSelection = editor.selection;
  const originalCode = editor.document.getText(originalSelection);
  const lang = editor.document.languageId;

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
          vscode.window.showErrorMessage(`Gemma hatası: ${(err as Error).message}`);
        }
        return;
      }

      if (token.isCancellationRequested) return;

      const proposed = extractCode(result, lang);
      if (!proposed || proposed === originalCode) {
        vscode.window.showInformationMessage('Gemma: Değişiklik önerisi yok.');
        return;
      }

      // Apply the edit
      const applied = await editor.edit((eb) => eb.replace(originalSelection, proposed));
      if (!applied) {
        vscode.window.showErrorMessage('Düzenleme uygulanamadı.');
        return;
      }

      // Offer undo
      const action = await vscode.window.showInformationMessage(
        `Gemma düzenlemeyi uyguladı.`,
        { modal: false },
        'Geri Al'
      );
      if (action === 'Geri Al') {
        await vscode.commands.executeCommand('undo');
      }
    }
  );
}
