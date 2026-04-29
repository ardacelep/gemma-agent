import * as vscode from 'vscode';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import { GemmaCompletionProvider } from './providers/completionProvider';
import { GemmaChatProvider } from './providers/chatProvider';
import { GemmaCodeActionProvider, registerCodeActionCommands } from './providers/codeActionProvider';
import { registerTerminalCommands } from './providers/terminalProvider';
import { isOllamaRunning, listModels } from './ollama/client';
import { inlineEdit } from './providers/inlineEditProvider';

let statusBarItem: vscode.StatusBarItem;
let ollamaStartedByUs = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'gemmaAgent.openChat';
  context.subscriptions.push(statusBarItem);

  await autoSelectModel();
  await updateStatusBar();

  const chatProvider = new GemmaChatProvider(context.extensionUri);

  const editorCfg = vscode.workspace.getConfiguration('editor');
  if (!editorCfg.get<boolean>('inlineSuggest.enabled')) {
    await editorCfg.update('inlineSuggest.enabled', true, vscode.ConfigurationTarget.Global);
  }

  const completionProvider = new GemmaCompletionProvider();
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider),
    completionProvider
  );

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider('*', new GemmaCodeActionProvider(), {
      providedCodeActionKinds: GemmaCodeActionProvider.providedCodeActionKinds,
    })
  );

  registerCodeActionCommands(context, chatProvider);
  registerTerminalCommands(context, chatProvider);

  context.subscriptions.push(
    vscode.commands.registerCommand('gemmaAgent.openChat', () => {
      chatProvider.openOrFocus();
    }),

    vscode.commands.registerCommand('gemmaAgent.startOllama', async () => {
      const macAppPath = findMacApp();

      if (macAppPath) {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Ollama', cancellable: false },
          async (progress) => {
            progress.report({ message: 'Başlatılıyor…' });
            await new Promise<void>((resolve, reject) => {
              cp.exec('open -g -a Ollama', (err) => err ? reject(err) : resolve());
            });
            progress.report({ message: 'Bağlantı bekleniyor…' });
            const ready = await pollUntilReady();
            if (ready) ollamaStartedByUs = true;
            progress.report({ message: ready ? 'Hazır ✓' : 'Başlatılamadı' });
            await new Promise((r) => setTimeout(r, 800));
          }
        );
        await updateStatusBar();
        return;
      }

      // CLI fallback
      const cliAvailable = await new Promise<boolean>((resolve) => {
        cp.exec('which ollama', (err) => resolve(!err));
      });

      if (cliAvailable) {
        const terminal = vscode.window.terminals.find((t) => t.name === 'Ollama') ??
          vscode.window.createTerminal({ name: 'Ollama' });
        terminal.show(true);
        terminal.sendText('ollama serve');
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Ollama', cancellable: false },
          async (progress) => {
            progress.report({ message: 'Sunucu başlatılıyor…' });
            const ready = await pollUntilReady();
            if (ready) ollamaStartedByUs = true;
            progress.report({ message: ready ? 'Hazır ✓' : 'Başlatılamadı' });
            await new Promise((r) => setTimeout(r, 800));
          }
        );
        await updateStatusBar();
        return;
      }

      const action = await vscode.window.showErrorMessage(
        'Ollama bulunamadı. Yüklemek ister misiniz?',
        'Mac Uygulamasını İndir'
      );
      if (action === 'Mac Uygulamasını İndir') {
        vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download/mac'));
      }
    }),

    vscode.commands.registerCommand('gemmaAgent.pullModel', async (modelName?: string) => {
      const model = modelName ?? await vscode.window.showInputBox({
        prompt: 'İndirilecek model adını girin',
        placeHolder: 'örn. gemma4:9b',
      });
      if (!model) return;
      const terminal = vscode.window.terminals.find((t) => t.name === 'Ollama') ??
        vscode.window.createTerminal({ name: 'Ollama' });
      terminal.show(true);
      terminal.sendText(`ollama pull ${model}`);
    }),

    vscode.commands.registerCommand('gemmaAgent.inlineEdit', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) inlineEdit(editor);
    }),

    vscode.commands.registerCommand('gemmaAgent.stopOllama', async () => {
      await stopOllama();
      ollamaStartedByUs = false;
      await updateStatusBar();
    }),

    vscode.commands.registerCommand('gemmaAgent.toggleCompletion', () => {
      const cfg = vscode.workspace.getConfiguration('gemmaAgent');
      const current = cfg.get<boolean>('completionEnabled', true);
      cfg.update('completionEnabled', !current, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Gemma inline completion: ${!current ? 'açık' : 'kapalı'}`);
      updateStatusBar();
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gemmaAgent')) updateStatusBar();
    })
  );

  const statusInterval = setInterval(updateStatusBar, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(statusInterval) });
}

// ── Yardımcı fonksiyonlar ─────────────────────────────────
function findMacApp(): string | undefined {
  const candidates = [
    '/Applications/Ollama.app',
    path.join(os.homedir(), 'Applications', 'Ollama.app'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}


async function stopOllama(): Promise<void> {
  const platform = os.platform();
  await new Promise<void>((resolve) => {
    if (platform === 'darwin') {
      cp.exec("osascript -e 'tell application \"Ollama\" to quit'", (err) => {
        if (!err) { resolve(); return; }
        cp.exec('pkill -x ollama', () => resolve());
      });
    } else if (platform === 'win32') {
      cp.exec('taskkill /IM ollama.exe /F', () => resolve());
    } else {
      // Linux / other Unix
      cp.exec('pkill -f ollama', () => resolve());
    }
  });
}

async function pollUntilReady(maxWaitMs = 15_000, intervalMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await isOllamaRunning()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function autoSelectModel(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('gemmaAgent');
  const configured = cfg.get<string>('model', '');
  const available = await listModels();
  if (!available.length) return;
  if (configured && available.includes(configured)) return;
  const gemmaModel = available.find((m) => m.toLowerCase().includes('gemma')) ?? available[0];
  await cfg.update('model', gemmaModel, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Gemma Agent: model otomatik seçildi → ${gemmaModel}`);
}

async function updateStatusBar(): Promise<void> {
  const running = await isOllamaRunning();
  const cfg = vscode.workspace.getConfiguration('gemmaAgent');
  const model = cfg.get<string>('model', 'gemma4:e4b');
  const completionOn = cfg.get<boolean>('completionEnabled', true);

  if (running) {
    statusBarItem.text = `$(sparkle) Gemma ${model}${completionOn ? '' : ' [kapalı]'}`;
    statusBarItem.tooltip = `Ollama çalışıyor — ${model}\nTıklayarak chat'i aç`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = '$(warning) Gemma: Bağlantı yok';
    statusBarItem.tooltip = 'Ollama çalışmıyor — ollama serve komutunu çalıştırın';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }
  statusBarItem.show();
}

export async function deactivate(): Promise<void> {
  statusBarItem?.dispose();

  if (!ollamaStartedByUs) return;

  const preference = vscode.workspace.getConfiguration('gemmaAgent')
    .get<string>('ollamaOnExit', 'keep');

  if (preference === 'stop') {
    await stopOllama();
    return;
  }

  if (preference === 'ask') {
    const choice = await vscode.window.showInformationMessage(
      'Ollama arka planda çalışmaya devam etsin mi?',
      { modal: true },
      'Çalışmaya Devam Et',
      'Durdur'
    );
    if (choice === 'Durdur') await stopOllama();
  }
}
