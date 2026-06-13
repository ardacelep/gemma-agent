import * as vscode from 'vscode';
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
          { label: '▶  Run selected code in terminal', id: 'run' },
          { label: '📖  Explain last terminal output', id: 'explainOutput' },
          { label: '🔧  Fix a terminal error', id: 'fixError' },
          { label: '💬  Generate a command to run the selected code', id: 'generateCommand' },
        ],
        { placeHolder: 'Choose a terminal action' }
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
            vscode.window.showWarningMessage('Select some code first.');
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
    vscode.window.showWarningMessage('No code selected to run.');
    return;
  }
  const code = editor.document.getText(editor.selection);
  const terminal = getOrCreateTerminal();
  terminal.show(true);
  terminal.sendText(code);
}

async function explainTerminalOutput(chatProvider: GemmaChatProvider): Promise<void> {
  const output = await promptForTerminalContent('Paste the terminal output here:');
  if (!output) return;
  await chatProvider.sendToChat('Explain this terminal output:', output);
}

async function fixTerminalError(
  chatProvider: GemmaChatProvider,
  editor?: vscode.TextEditor
): Promise<void> {
  const error = await promptForTerminalContent('Paste the error message here:');
  if (!error) return;

  let codeContext = '';
  if (editor && !editor.selection.isEmpty) {
    codeContext = editor.document.getText(editor.selection);
  }

  const prompt = codeContext
    ? `Look at the error message and the related code below, then fix the error:\n\nError:\n${error}`
    : `Analyze this terminal error and suggest a fix:\n\n${error}`;

  await chatProvider.sendToChat(prompt, codeContext || '');
}

async function generateTerminalCommand(
  chatProvider: GemmaChatProvider,
  editor: vscode.TextEditor
): Promise<void> {
  const code = editor.document.getText(editor.selection);
  const lang = editor.document.languageId;
  await chatProvider.sendToChat(
    `Generate the terminal commands needed to run this ${lang} code (including build steps and dependency installation):`,
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
