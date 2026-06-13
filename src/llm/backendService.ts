import * as vscode from 'vscode';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as os from 'os';
import * as path from 'path';
import {
  ApiProtocol,
  DEFAULT_MODEL,
  getApiProtocol,
  getCapabilities,
  getProvider,
  listModels,
  pullModelStream,
} from './client';
import { LlmCapabilities } from './provider';

export type ServerState = 'unknown' | 'not-installed' | 'not-running' | 'no-models' | 'ready';

export interface PullJob {
  status: string;
  percent?: number;
}

export interface BackendState {
  protocol: ApiProtocol;
  baseUrl: string;
  serverState: ServerState;
  models: string[];
  activeModel: string;
  serverInstalled: boolean;
  capabilities: LlmCapabilities;
  pulls: Record<string, PullJob>;
}

const BACKOFF_START_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
// Poll fairly often while connected so closing the server is noticed quickly
// (localhost /api/tags with a 2s timeout — cheap).
const CONNECTED_POLL_MS = 15_000;
const RECHECK_FAST_MS = 3_000; // while the setup wizard is waiting on the user

/**
 * Single source of truth for backend connectivity. Status bar, chat webview
 * and the setup wizard all subscribe to `onDidChange` so they never disagree.
 */
export class BackendService {
  private readonly emitter = new vscode.EventEmitter<BackendState>();
  readonly onDidChange = this.emitter.event;

  private timer?: ReturnType<typeof setTimeout>;
  private backoffMs = BACKOFF_START_MS;
  private refreshing = false;
  private fastRecheck = false;
  private readonly pullAborts = new Map<string, AbortController>();

  private _state: BackendState = {
    protocol: 'ollama',
    baseUrl: 'http://localhost:11434',
    serverState: 'unknown',
    models: [],
    activeModel: DEFAULT_MODEL,
    serverInstalled: false,
    capabilities: getCapabilities(),
    pulls: {},
  };

  get state(): BackendState {
    return this._state;
  }

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.emitter,
      { dispose: () => this.stopTimer() },
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gemmaAgent')) void this.refresh();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) void this.refresh();
      })
    );
    void this.refresh();
  }

  /** Re-evaluate server state now and reschedule the next check. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    this.stopTimer();
    try {
      const cfg = vscode.workspace.getConfiguration('gemmaAgent');
      const protocol = getApiProtocol();
      const baseUrl = cfg.get<string>('ollamaUrl', 'http://localhost:11434');
      const activeModel = cfg.get<string>('model', DEFAULT_MODEL);
      const capabilities = getCapabilities();
      const serverInstalled = protocol === 'ollama' ? this.isOllamaInstalled() : true;

      let serverState: ServerState;
      let models: string[] = [];

      if (protocol === 'ollama' && !serverInstalled) {
        serverState = 'not-installed';
      } else {
        const healthy = await getProvider().health();
        if (!healthy) {
          serverState = 'not-running';
        } else {
          models = await listModels();
          serverState = models.length === 0 ? 'no-models' : 'ready';
        }
      }

      this.setState({ protocol, baseUrl, activeModel, capabilities, serverInstalled, serverState, models });
      this.scheduleNext(serverState === 'ready');
    } finally {
      this.refreshing = false;
    }
  }

  /** While the setup wizard is open we poll faster so the user sees progress. */
  setFastRecheck(on: boolean): void {
    this.fastRecheck = on;
    if (on) void this.refresh();
  }

  isOllamaInstalled(): boolean {
    const macApp = [
      '/Applications/Ollama.app',
      path.join(os.homedir(), 'Applications', 'Ollama.app'),
    ].some((p) => fs.existsSync(p));
    if (macApp) return true;
    try {
      const which = os.platform() === 'win32' ? 'where ollama' : 'which ollama';
      cp.execSync(which, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /** Probe well-known local server ports; returns reachable {label, url, protocol}. */
  async detectServers(): Promise<Array<{ label: string; url: string; protocol: ApiProtocol }>> {
    const candidates: Array<{ label: string; url: string; protocol: ApiProtocol; probe: string }> = [
      { label: 'Ollama', url: 'http://localhost:11434', protocol: 'ollama', probe: '/api/tags' },
      { label: 'LM Studio', url: 'http://localhost:1234', protocol: 'openai-compatible', probe: '/v1/models' },
      { label: 'Jan', url: 'http://localhost:1337', protocol: 'openai-compatible', probe: '/v1/models' },
      { label: 'llama.cpp', url: 'http://localhost:8080', protocol: 'openai-compatible', probe: '/v1/models' },
    ];
    const found: Array<{ label: string; url: string; protocol: ApiProtocol }> = [];
    await Promise.all(candidates.map(async (c) => {
      try {
        const res = await fetch(`${c.url}${c.probe}`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) found.push({ label: c.label, url: c.url, protocol: c.protocol });
      } catch { /* not running */ }
    }));
    return found;
  }

  async pull(model: string): Promise<void> {
    if (!this._state.capabilities.canPull) {
      throw new Error('This backend does not support downloading models.');
    }
    const abort = new AbortController();
    this.pullAborts.set(model, abort);
    this.updatePull(model, { status: 'starting', percent: 0 });
    try {
      await pullModelStream(model, (p) => this.updatePull(model, p), abort.signal);
      this.clearPull(model);
      await this.refresh();
    } catch (err) {
      this.clearPull(model);
      if ((err as Error).name !== 'AbortError') throw err;
    } finally {
      this.pullAborts.delete(model);
    }
  }

  cancelPull(model: string): void {
    this.pullAborts.get(model)?.abort();
    this.pullAborts.delete(model);
    this.clearPull(model);
  }

  private updatePull(model: string, job: PullJob): void {
    this._state = { ...this._state, pulls: { ...this._state.pulls, [model]: job } };
    this.emitter.fire(this._state);
  }

  private clearPull(model: string): void {
    const pulls = { ...this._state.pulls };
    delete pulls[model];
    this._state = { ...this._state, pulls };
    this.emitter.fire(this._state);
  }

  private setState(patch: Partial<BackendState>): void {
    this._state = { ...this._state, ...patch };
    this.emitter.fire(this._state);
  }

  private scheduleNext(ready: boolean): void {
    if (ready) {
      this.backoffMs = BACKOFF_START_MS;
      this.timer = setTimeout(() => void this.refresh(), CONNECTED_POLL_MS);
    } else if (this.fastRecheck) {
      this.timer = setTimeout(() => void this.refresh(), RECHECK_FAST_MS);
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
