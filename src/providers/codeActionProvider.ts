import * as vscode from 'vscode';
import { ollamaGenerate } from '../ollama/client';
import { GemmaChatProvider } from './chatProvider';

type ActionKind = 'explain' | 'refactor' | 'fix' | 'tests';

const ACTION_PROMPTS: Record<ActionKind, { title: string; prompt: (lang: string) => string }> = {
  explain: {
    title: 'Gemma: Kodu Açıkla',
    prompt: (lang) => `Bu ${lang} kodunu Türkçe olarak adım adım açıkla:`,
  },
  refactor: {
    title: 'Gemma: Kodu Refactor Et',
    prompt: (lang) =>
      `Bu ${lang} kodunu daha okunabilir, temiz ve verimli hale getir. Sadece düzenlenmiş kodu ver, açıklama ekleme:`,
  },
  fix: {
    title: 'Gemma: Hataları Düzelt',
    prompt: (lang) =>
      `Bu ${lang} kodundaki hataları ve sorunları tespit edip düzelt. Düzeltilmiş kodu ver ve kısa bir özet ekle:`,
  },
  tests: {
    title: 'Gemma: Test Yaz',
    prompt: (lang) => `Bu ${lang} kodu için kapsamlı unit testler yaz:`,
  },
};

export class GemmaCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): vscode.CodeAction[] {
    if (range.isEmpty) return [];
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    if (!cfg.get<boolean>('codeActionsEnabled', true)) return [];

    return (Object.keys(ACTION_PROMPTS) as ActionKind[]).map((kind) => {
      const action = new vscode.CodeAction(
        ACTION_PROMPTS[kind].title,
        kind === 'fix' ? vscode.CodeActionKind.QuickFix : vscode.CodeActionKind.Refactor
      );
      action.command = {
        command: `gemmaAgent.${kind}Code`,
        title: ACTION_PROMPTS[kind].title,
      };
      return action;
    });
  }
}

export function registerCodeActionCommands(
  context: vscode.ExtensionContext,
  chatProvider: GemmaChatProvider
): void {
  const actions: { id: string; kind: ActionKind }[] = [
    { id: 'gemmaAgent.explainCode', kind: 'explain' },
    { id: 'gemmaAgent.refactorCode', kind: 'refactor' },
    { id: 'gemmaAgent.fixCode', kind: 'fix' },
    { id: 'gemmaAgent.generateTests', kind: 'tests' },
  ];

  for (const { id, kind } of actions) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selection.isEmpty) {
          vscode.window.showWarningMessage('Lütfen önce bir kod seçin.');
          return;
        }
        const selectedCode = editor.document.getText(editor.selection);
        const lang = editor.document.languageId;
        const promptText = ACTION_PROMPTS[kind].prompt(lang);

        if (kind === 'explain') {
          // explain goes to chat panel for better readability
          await chatProvider.sendToChat(promptText, selectedCode);
        } else {
          await chatProvider.sendToChat(promptText, selectedCode);
        }
      })
    );
  }
}

/** Inline quick-fix that replaces selection with model output (refactor / fix). */
export async function applyInlineEdit(
  editor: vscode.TextEditor,
  kind: 'refactor' | 'fix'
): Promise<void> {
  const selectedCode = editor.document.getText(editor.selection);
  const lang = editor.document.languageId;
  const prompt = `${ACTION_PROMPTS[kind].prompt(lang)}\n\`\`\`${lang}\n${selectedCode}\n\`\`\`\n\nSadece kodu döndür, ek açıklama ekleme.`;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Gemma işliyor...', cancellable: true },
    async (_progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      try {
        const result = await ollamaGenerate({ prompt, signal: abort.signal });
        const cleaned = extractCodeBlock(result, lang);
        await editor.edit((eb) => eb.replace(editor.selection, cleaned));
      } catch (err: unknown) {
        if ((err as Error).name !== 'AbortError') {
          vscode.window.showErrorMessage(`Gemma hatası: ${(err as Error).message}`);
        }
      }
    }
  );
}

function extractCodeBlock(text: string, lang: string): string {
  const fenced = new RegExp(`\`\`\`(?:${lang})?\\n?([\\s\\S]*?)\`\`\``, 'i');
  const match = text.match(fenced);
  return match ? match[1].trim() : text.trim();
}
