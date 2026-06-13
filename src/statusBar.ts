import * as vscode from 'vscode';
import { DEFAULT_MODEL, isOllamaRunning } from './ollama/client';

const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const CONNECTED_POLL_MS = 120_000;

/**
 * Status bar item with event-driven refresh instead of fixed polling:
 * refresh() runs on activation, config changes, window focus and after
 * start/stop commands. While disconnected it retries with backoff
 * (5s → 10s → … → 60s); while connected it only re-checks every 2 min.
 */
export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  private timer?: ReturnType<typeof setTimeout>;
  private backoffMs = BACKOFF_START_MS;
  private refreshing = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'gemmaAgent.openChat';
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.item,
      { dispose: () => this.stopTimer() },
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gemmaAgent')) void this.refresh();
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.refresh();
      })
    );
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.stopTimer();
    try {
      const running = await isOllamaRunning();
      this.render(running);
      this.scheduleNext(running);
    } finally {
      this.refreshing = false;
    }
  }

  private render(running: boolean): void {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    const model = cfg.get<string>('model', DEFAULT_MODEL);
    const completionOn = cfg.get<boolean>('completionEnabled', true);

    if (running) {
      this.item.text = `$(sparkle) Gemma ${model}${completionOn ? '' : ' [off]'}`;
      this.item.tooltip = `Ollama running — ${model}\nClick to open chat`;
      this.item.backgroundColor = undefined;
    } else {
      this.item.text = '$(warning) Gemma: Not connected';
      this.item.tooltip = 'Ollama is not running — click to open chat and start it';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    this.item.show();
  }

  private scheduleNext(running: boolean): void {
    if (running) {
      this.backoffMs = BACKOFF_START_MS;
      this.timer = setTimeout(() => void this.refresh(), CONNECTED_POLL_MS);
    } else {
      this.timer = setTimeout(() => void this.refresh(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
