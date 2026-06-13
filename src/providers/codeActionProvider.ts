import * as vscode from 'vscode';
import { GemmaChatProvider } from './chatProvider';

type ActionKind = 'explain' | 'refactor' | 'fix' | 'tests';

const ACTION_PROMPTS: Record<ActionKind, { title: string; prompt: (lang: string) => string }> = {
  explain: {
    title: 'Gemma: Explain Code',
    prompt: (lang) => `Explain this ${lang} code step by step:`,
  },
  refactor: {
    title: 'Gemma: Refactor Code',
    prompt: (lang) =>
      `Refactor this ${lang} code to be more readable, clean and efficient. Return only the refactored code, no extra explanation:`,
  },
  fix: {
    title: 'Gemma: Fix Issues',
    prompt: (lang) =>
      `Find and fix the bugs and issues in this ${lang} code. Return the fixed code with a short summary:`,
  },
  tests: {
    title: 'Gemma: Generate Tests',
    prompt: (lang) => `Write comprehensive unit tests for this ${lang} code:`,
  },
};

export class GemmaCodeActionProvider implements vscode.CodeActionProvider {
  static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    if (!cfg.get<boolean>('codeActionsEnabled', true)) return [];

    const actions: vscode.CodeAction[] = [];

    // "✨ Fix with Gemma" — preferred quick-fix when there's a diagnostic here
    // (works without a selection, unlike the explain/refactor actions below)
    for (const d of context.diagnostics) {
      const fix = new vscode.CodeAction('✨ Fix with Gemma', vscode.CodeActionKind.QuickFix);
      fix.diagnostics = [d];
      fix.isPreferred = true;
      const code = typeof d.code === 'object' && d.code !== null ? String(d.code.value) : (d.code !== undefined ? String(d.code) : '');
      fix.command = {
        command: 'gemmaAgent.fixDiagnostic',
        title: '✨ Fix with Gemma',
        arguments: [document.uri, d.range, d.message, code],
      };
      actions.push(fix);
    }

    // Explain / refactor / fix / tests — require a selection
    if (!range.isEmpty) {
      for (const kind of Object.keys(ACTION_PROMPTS) as ActionKind[]) {
        const action = new vscode.CodeAction(
          ACTION_PROMPTS[kind].title,
          kind === 'fix' ? vscode.CodeActionKind.QuickFix : vscode.CodeActionKind.Refactor
        );
        action.command = { command: `gemmaAgent.${kind}Code`, title: ACTION_PROMPTS[kind].title };
        actions.push(action);
      }
    }

    return actions;
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
          vscode.window.showWarningMessage('Select some code first.');
          return;
        }
        const selectedCode = editor.document.getText(editor.selection);
        const lang = editor.document.languageId;
        await chatProvider.sendToChat(ACTION_PROMPTS[kind].prompt(lang), selectedCode);
      })
    );
  }
}
