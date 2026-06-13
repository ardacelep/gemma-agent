import * as vscode from 'vscode';
import { GemmaChatProvider } from './chatProvider';
import { StatusBarManager } from '../statusBar';

// ── Shell execution capture (VS Code Shell Integration API) ───────────────
interface CapturedExecution {
  command: string;
  cwd?: string;
  exitCode?: number;
  output: string;
  endedAt: number;
}

const RING_MAX = 5;
const OUTPUT_CAP = 8 * 1024;
const ring: CapturedExecution[] = [];

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function getLastExecutions(): CapturedExecution[] {
  return [...ring].reverse(); // most recent first
}

export function hasTerminalCapture(): boolean {
  return ring.length > 0;
}

/**
 * Subscribe to terminal shell executions and keep a ring buffer of the last
 * few {command, exitCode, output}. The output reader is started synchronously
 * in the start handler so early output isn't lost. Degrades silently when the
 * shell has no integration.
 */
export function registerTerminalCapture(context: vscode.ExtensionContext, statusBar: StatusBarManager): void {
  // These events exist since VS Code 1.88; guard in case of older hosts.
  const onStart = (vscode.window as { onDidStartTerminalShellExecution?: vscode.Event<vscode.TerminalShellExecutionStartEvent> }).onDidStartTerminalShellExecution;
  const onEnd = (vscode.window as { onDidEndTerminalShellExecution?: vscode.Event<vscode.TerminalShellExecutionEndEvent> }).onDidEndTerminalShellExecution;
  if (!onStart || !onEnd) return;

  const records = new Map<vscode.TerminalShellExecution, CapturedExecution>();

  context.subscriptions.push(
    onStart((e) => {
      const rec: CapturedExecution = {
        command: e.execution.commandLine.value,
        cwd: e.execution.cwd?.fsPath,
        output: '',
        endedAt: 0,
      };
      records.set(e.execution, rec);
      // Start draining the stream immediately (synchronously kicked off)
      void (async () => {
        try {
          for await (const chunk of e.execution.read()) {
            rec.output = (rec.output + chunk).replace(ANSI_RE, '').slice(-OUTPUT_CAP);
          }
        } catch { /* stream closed */ }
      })();
    }),
    onEnd((e) => {
      const rec = records.get(e.execution);
      records.delete(e.execution);
      if (!rec) return;
      rec.exitCode = e.exitCode;
      rec.endedAt = Date.now();
      ring.push(rec);
      while (ring.length > RING_MAX) ring.shift();
      // Flash a one-tap "fix last error?" hint on failure (rate-limited)
      if (typeof e.exitCode === 'number' && e.exitCode !== 0) {
        statusBar.flashHint('$(warning) Gemma: fix last error?', 'gemmaAgent.fixLastTerminalError');
      }
    })
  );
}

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
    }),

    vscode.commands.registerCommand('gemmaAgent.fixLastTerminalError', async () => {
      const last = getLastExecutions().find((e) => e.exitCode !== 0) ?? getLastExecutions()[0];
      if (!last) {
        vscode.window.showInformationMessage('Gemma: no recent terminal command captured.');
        return;
      }
      await chatProvider.sendToChat(
        `This command failed (exit code ${last.exitCode}). Explain why and how to fix it:\n\n$ ${last.command}`,
        last.output || '(no output captured)'
      );
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

/** Let the user pick a captured execution, or fall back to manual paste. */
async function pickCapturedOutput(action: string): Promise<{ command?: string; output: string; exitCode?: number } | undefined> {
  const execs = getLastExecutions();
  if (execs.length === 0) {
    const pasted = await promptForTerminalContent('Paste the terminal output here:');
    return pasted ? { output: pasted } : undefined;
  }
  const items = execs.map((e, i) => ({
    label: `$ ${e.command.slice(0, 60)}`,
    description: `${e.exitCode === 0 ? '✓' : `exit ${e.exitCode}`} · ${relativeTime(e.endedAt)}`,
    idx: i,
  }));
  const manual = { label: 'Paste manually…', description: '', idx: -1 };
  const choice = await vscode.window.showQuickPick([...items, manual], { placeHolder: `Choose a command to ${action}` });
  if (!choice) return undefined;
  if (choice.idx === -1) {
    const pasted = await promptForTerminalContent('Paste the terminal output here:');
    return pasted ? { output: pasted } : undefined;
  }
  const e = execs[choice.idx];
  return { command: e.command, output: e.output, exitCode: e.exitCode };
}

async function explainTerminalOutput(chatProvider: GemmaChatProvider): Promise<void> {
  const picked = await pickCapturedOutput('explain');
  if (!picked) return;
  const header = picked.command ? `$ ${picked.command}\n` : '';
  await chatProvider.sendToChat('Explain this terminal output:', header + picked.output);
}

async function fixTerminalError(
  chatProvider: GemmaChatProvider,
  editor?: vscode.TextEditor
): Promise<void> {
  const picked = await pickCapturedOutput('fix');
  if (!picked) return;

  let codeContext = '';
  if (editor && !editor.selection.isEmpty) {
    codeContext = editor.document.getText(editor.selection);
  }
  const header = picked.command ? `$ ${picked.command}\n` : '';
  const errorBlock = header + picked.output;
  const prompt = codeContext
    ? `Look at the error and the related code below, then fix the error:\n\nError:\n${errorBlock}`
    : `Analyze this terminal error and suggest a fix:\n\n${errorBlock}`;

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

function relativeTime(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}
