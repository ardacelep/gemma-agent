import * as vscode from 'vscode';
import { BackendService, BackendState } from './llm/backendService';

/**
 * Status bar item — a pure renderer of BackendService state. All polling and
 * connectivity logic lives in BackendService so the bar, the chat banner and
 * the setup wizard can never disagree.
 */
export class StatusBarManager {
  private readonly item: vscode.StatusBarItem;
  /** Temporary hint that overrides the normal text for a few seconds. */
  private hintTimer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private busyTimer?: ReturnType<typeof setTimeout>;
  private lastHintAt = 0;

  constructor(private readonly backend: BackendService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'gemmaAgent.openChat';
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.item,
      this.backend.onDidChange((s) => this.render(s)),
      { dispose: () => { if (this.hintTimer) clearTimeout(this.hintTimer); if (this.busyTimer) clearTimeout(this.busyTimer); } }
    );
    this.render(this.backend.state);
  }

  /** Briefly flash a clickable hint (rate-limited to once per 30s). */
  flashHint(text: string, command: string, durationMs = 8000): void {
    const now = Date.now();
    if (now - this.lastHintAt < 30_000) return;
    this.lastHintAt = now;
    if (this.hintTimer) clearTimeout(this.hintTimer);
    this.item.text = text;
    this.item.command = command;
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    this.item.show();
    this.hintTimer = setTimeout(() => {
      this.hintTimer = undefined;
      this.item.command = 'gemmaAgent.openChat';
      this.render(this.backend.state);
    }, durationMs);
  }

  /** Show a spinner while a completion request is in flight (debounced). */
  setBusy(on: boolean): void {
    if (on) {
      if (this.busyTimer) return;
      this.busyTimer = setTimeout(() => { this.busy = true; this.render(this.backend.state); }, 300);
    } else {
      if (this.busyTimer) { clearTimeout(this.busyTimer); this.busyTimer = undefined; }
      if (this.busy) {
        setTimeout(() => { this.busy = false; this.render(this.backend.state); }, 200);
      }
    }
  }

  private render(s: BackendState): void {
    if (this.hintTimer) return; // a hint is currently showing
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    const model = s.activeModel || cfg.get<string>('model', 'gemma4:e4b');
    const completionOn = cfg.get<boolean>('completionEnabled', true);

    if (s.serverState === 'ready') {
      const icon = this.busy ? '$(loading~spin)' : '$(sparkle)';
      this.item.text = `${icon} Gemma ${model}${completionOn ? '' : ' [off]'}`;
      this.item.tooltip = `Local AI connected — ${model}\nClick to open Gemma`;
      this.item.backgroundColor = undefined;
    } else {
      const label = s.serverState === 'no-models'
        ? 'Gemma: no models'
        : s.serverState === 'not-installed'
        ? 'Gemma: set up'
        : 'Gemma: not connected';
      this.item.text = `$(warning) ${label}`;
      this.item.tooltip = 'Click to open Gemma and finish setup';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    this.item.show();
  }
}
