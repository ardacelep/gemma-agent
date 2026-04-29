import * as vscode from 'vscode';
import { ollamaGenerate } from '../ollama/client';
import { GemmaChatProvider } from './chatProvider';

export function registerTerminalCommands(
  context: vscode.ExtensionContext,
  chatProvider: GemmaChatProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('gemmaAgent.runInTerminal', async () => {
      const editor = vscode.window.activeTextEditor;
      const hasSelection = editor && !editor.selection.isEmpty;

      const choice = await vscode.window.showQuickPick(
        [
          { label: '▶  Seçili kodu terminalde çalıştır', id: 'run' },
          { label: '📖  Terminaldeki son çıktıyı açıkla', id: 'explainOutput' },
          { label: '🔧  Terminaldeki hatayı düzelt', id: 'fixError' },
          { label: '💬  Seçili kodu terminalde çalıştıracak komut üret', id: 'generateCommand' },
        ],
        { placeHolder: 'Terminal eylemi seçin' }
      );

      if (!choice) return;

      switch (choice.id) {
        case 'run':
          await runSelectionInTerminal(editor);
          break;
        case 'explainOutput':
          await explainTerminalOutput(chatProvider);
          break;
        case 'fixError':
          await fixTerminalError(chatProvider, editor ?? undefined);
          break;
        case 'generateCommand':
          if (!hasSelection) {
            vscode.window.showWarningMessage('Lütfen önce kodu seçin.');
            return;
          }
          await generateTerminalCommand(chatProvider, editor!);
          break;
      }
    })
  );
}

async function runSelectionInTerminal(editor?: vscode.TextEditor): Promise<void> {
  if (!editor || editor.selection.isEmpty) {
    vscode.window.showWarningMessage('Çalıştırılacak kod seçili değil.');
    return;
  }
  const code = editor.document.getText(editor.selection);
  const terminal = getOrCreateTerminal();
  terminal.show(true);
  terminal.sendText(code);
}

async function explainTerminalOutput(chatProvider: GemmaChatProvider): Promise<void> {
  const output = await promptForTerminalContent('Terminal çıktısını buraya yapıştırın:');
  if (!output) return;
  await chatProvider.sendToChat('Bu terminal çıktısını Türkçe açıkla:', output);
}

async function fixTerminalError(
  chatProvider: GemmaChatProvider,
  editor?: vscode.TextEditor
): Promise<void> {
  const error = await promptForTerminalContent('Hata mesajını buraya yapıştırın:');
  if (!error) return;

  let codeContext = '';
  if (editor && !editor.selection.isEmpty) {
    codeContext = editor.document.getText(editor.selection);
  }

  const prompt = codeContext
    ? `Aşağıdaki hata mesajı ve ilgili kodu inceleyerek hatayı düzelt:\n\nHata:\n${error}`
    : `Aşağıdaki terminal hatasını analiz et ve çözüm öner:\n\n${error}`;

  await chatProvider.sendToChat(prompt, codeContext || '');
}

async function generateTerminalCommand(
  chatProvider: GemmaChatProvider,
  editor: vscode.TextEditor
): Promise<void> {
  const code = editor.document.getText(editor.selection);
  const lang = editor.document.languageId;
  await chatProvider.sendToChat(
    `Bu ${lang} kodunu çalıştırmak için gerekli terminal komutlarını üret (derleme, bağımlılık kurulumu, çalıştırma adımları dahil):`,
    code
  );
}

async function promptForTerminalContent(placeholder: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: placeholder,
    placeHolder: placeholder,
    ignoreFocusOut: true,
  });
}

function getOrCreateTerminal(): vscode.Terminal {
  const existing = vscode.window.terminals.find((t) => t.name === 'Gemma Agent');
  return existing ?? vscode.window.createTerminal('Gemma Agent');
}
