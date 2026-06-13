import * as vscode from 'vscode';
import { DEFAULT_MODEL, OllamaMessage, describeOllamaError, ollamaChat, unloadModel, warmupModel } from '../llm/client';
import { computeBudget, fitMessages } from '../llm/contextWindow';
import { getInstructionSuffix } from '../llm/instructions';
import { BackendService } from '../llm/backendService';
import { getLastExecutions, hasTerminalCapture } from './terminalProvider';
import { AgentHooks, runAgentLoop } from '../agent/agentLoop';
import { Checkpoint } from '../agent/checkpoints';
import { ToolCall } from '../agent/tools';
import {
  Entry, Session, StoreV2,
  autoTitle, capStore, entriesToMessages, isDefaultTitle, migrateV1, newSession, parseStoreV2,
} from './sessionStore';
import { getNonce, getWebviewUri } from '../webview/utils';

const STATIC_MODELS = ['gemma4:e4b', 'gemma4:e2b', 'gemma4:9b', 'gemma4:12b', 'gemma4:27b', 'gemma3:1b', 'gemma3:4b', 'gemma3:12b', 'gemma3:27b', 'gemma3n:e2b', 'gemma3n:e4b'];

export const CHAT_VIEW_ID = 'gemmaAgent.chatView';

// ── Persisted chat sessions ─────────────────────────────────
const V1_KEY = 'gemmaAgent.chatHistory.v1';
const SESSIONS_KEY = 'gemmaAgent.chatSessions.v2';

// ── Slash commands ──────────────────────────────────────────
interface SlashCommand { name: string; description: string; prompt?: string }

const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'explain', description: 'Explain the selected code or active file', prompt: 'Explain this code step by step:' },
  { name: 'fix', description: 'Find and fix issues in the code', prompt: 'Find and fix the bugs and issues in this code. Return the fixed code with a short summary:' },
  { name: 'tests', description: 'Generate unit tests for the code', prompt: 'Write comprehensive unit tests for this code:' },
  { name: 'docs', description: 'Write documentation for the code', prompt: 'Write clear documentation comments for this code:' },
  { name: 'clear', description: 'Clear the conversation' },
];

const CHAT_SYSTEM_PROMPT =
  'You are a software development assistant.\n' +
  'Rules:\n' +
  '- Be concise. Do not write long introductory paragraphs.\n' +
  '- Always write code blocks as ```lang ... ``` and ALWAYS close them.\n' +
  '- If an explanation is needed, write it AFTER the code.\n' +
  '- Do not offer multiple options; give the best solution directly.\n' +
  '- Always respond in the same language the user writes in.';

export class GemmaChatProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private viewReady?: Promise<void>;
  private resolveViewReady?: () => void;
  private sessions: Session[] = [];
  private activeId = '';
  private activeAbort?: AbortController;
  private warmupAbort?: AbortController;
  private agentMode = false;
  private readonly extensionUri: vscode.Uri;
  private readonly pendingApprovals = new Map<string, (d: 'approve' | 'deny') => void>();
  private sessionAutoApprove = false;
  private lastCheckpoint?: Checkpoint;
  private fileListCache?: { ts: number; files: string[] };
  /** Track the in-flight tool call so tool_result can be recorded as an entry. */
  private pendingToolEntry?: { tool: string; arg: string };

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly backend: BackendService
  ) {
    this.extensionUri = context.extensionUri;
    this.loadStore();
    this.viewReady = new Promise((r) => { this.resolveViewReady = r; });
    // Keep the webview in sync with backend connectivity
    context.subscriptions.push(this.backend.onDidChange(() => this.pushBackendState()));
  }

  // ── Session persistence ─────────────────────────────────
  private loadStore(): void {
    const v2 = parseStoreV2(this.context.workspaceState.get(SESSIONS_KEY));
    if (v2) {
      this.sessions = v2.sessions;
      this.activeId = v2.sessions.some((s) => s.id === v2.activeId) ? v2.activeId : v2.sessions[0].id;
      return;
    }
    // Migrate a v1 single conversation if present (write-validate-delete)
    const migrated = migrateV1(this.context.workspaceState.get(V1_KEY));
    if (migrated) {
      this.sessions = [migrated];
      this.activeId = migrated.id;
      this.saveStore();
      if (parseStoreV2(this.context.workspaceState.get(SESSIONS_KEY))) {
        void this.context.workspaceState.update(V1_KEY, undefined);
      }
      return;
    }
    const fresh = newSession();
    this.sessions = [fresh];
    this.activeId = fresh.id;
  }

  private saveStore(): void {
    const store: StoreV2 = capStore({ version: 2, activeId: this.activeId, sessions: this.sessions });
    this.sessions = store.sessions;
    this.activeId = store.activeId;
    void this.context.workspaceState.update(SESSIONS_KEY, store);
  }

  private get active(): Session {
    let s = this.sessions.find((x) => x.id === this.activeId);
    if (!s) {
      s = this.sessions[0] ?? newSession();
      if (this.sessions.length === 0) this.sessions.push(s);
      this.activeId = s.id;
    }
    return s;
  }

  /** Append a transcript entry to the active session and persist. */
  private addEntry(entry: Entry): void {
    const s = this.active;
    s.entries.push(entry);
    s.updatedAt = entry.ts;
    if (entry.kind === 'user' && isDefaultTitle(s.title)) {
      s.title = autoTitle(entry.content);
      this.postSessionList();
    }
    this.saveStore();
  }

  /** LLM-facing history for the active session (user/assistant only). */
  private llmHistory(): OllamaMessage[] {
    return entriesToMessages(this.active.entries);
  }

  private postSessionList(): void {
    this.post({
      type: 'sessionList',
      sessions: this.sessions
        .map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt),
      activeId: this.activeId,
    });
  }

  /** Reset transient per-session run state (called on switch/new/delete). */
  private resetRunState(): void {
    this.activeAbort?.abort();
    for (const resolve of this.pendingApprovals.values()) resolve('deny');
    this.pendingApprovals.clear();
    this.sessionAutoApprove = false;
    this.lastCheckpoint = undefined;
  }

  private restoreActiveSession(): void {
    this.postSessionList();
    this.post({ type: 'restoreSession', entries: this.active.entries });
  }

  private createSession(): void {
    this.resetRunState();
    const s = newSession();
    this.sessions.push(s);
    this.activeId = s.id;
    this.saveStore();
    this.restoreActiveSession();
  }

  private switchSession(id: string): void {
    if (id === this.activeId || !this.sessions.some((s) => s.id === id)) return;
    this.resetRunState();
    this.activeId = id;
    this.saveStore();
    this.restoreActiveSession();
  }

  private renameSession(id: string, title: string): void {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    s.title = title.trim() || s.title;
    this.saveStore();
    this.postSessionList();
  }

  private deleteSession(id: string): void {
    const idx = this.sessions.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const wasActive = id === this.activeId;
    if (wasActive) this.resetRunState();
    this.sessions.splice(idx, 1);
    if (this.sessions.length === 0) this.sessions.push(newSession());
    if (wasActive) {
      // Activate the most recently updated remaining session
      this.activeId = [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
    }
    this.saveStore();
    if (wasActive) this.restoreActiveSession();
    else this.postSessionList();
  }

  /** Reveal the chat view in the sidebar. */
  openOrFocus(): void {
    void vscode.commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.buildHtml(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'sendMessage':   await this.handleUserMessage(msg.text, msg.contexts); break;
        case 'clearHistory':
          this.active.entries = [];
          this.active.title = newSession().title;
          this.sessionAutoApprove = false;
          this.saveStore();
          this.postSessionList();
          break;
        case 'newSession':    this.createSession(); break;
        case 'switchSession': this.switchSession(msg.id as string); break;
        case 'renameSession': this.renameSession(msg.id as string, msg.title as string); break;
        case 'deleteSession': this.deleteSession(msg.id as string); break;
        case 'toolApproval': {
          const callId = msg.callId as string;
          const resolver = this.pendingApprovals.get(callId);
          if (resolver) {
            if (msg.decision === 'always') this.sessionAutoApprove = true;
            const decision = msg.decision === 'deny' ? 'deny' : 'approve';
            resolver(decision);
            this.post({ type: 'toolApprovalResolved', callId, approved: decision === 'approve' });
          }
          break;
        }
        case 'undoCheckpoint': await this.undoLastCheckpoint(); break;
        case 'requestFileList': await this.sendFileList(msg.query as string); break;
        case 'attachFile': await this.attachFileContext(msg.path as string); break;
        case 'attachTerminal': this.attachTerminalContext(); break;
        case 'stopGeneration': this.activeAbort?.abort(); break;
        case 'insertCode':    this.insertCodeToEditor(msg.code); break;
        case 'changeModel':
          await this.handleModelChange(msg.model as string);
          break;
        case 'toggleFeature': await this.toggleFeature(msg.feature as string); break;
        case 'requestContext': await this.handleContextRequest(msg.source as string); break;
        case 'toggleAgentMode':
          this.agentMode = !this.agentMode;
          this.post({ type: 'agentMode', enabled: this.agentMode });
          break;
        case 'refreshModels': await this.backend.refresh(); break;
        case 'stopOllama':
          await vscode.commands.executeCommand('gemmaAgent.stopOllama');
          await this.backend.refresh();
          break;
        case 'pullModel':
          await this.pullModel(msg.model as string);
          break;
        case 'cancelPull':
          this.backend.cancelPull(msg.model as string);
          break;
        case 'startOllama':
          await vscode.commands.executeCommand('gemmaAgent.startOllama');
          await this.backend.refresh();
          break;
        case 'installServer':
          await vscode.commands.executeCommand('gemmaAgent.installServer');
          break;
        case 'selectProviderPreset':
          await this.applyProviderPreset(msg.preset as string);
          break;
        case 'detectServers': {
          const found = await this.backend.detectServers();
          this.post({ type: 'detectedServers', servers: found });
          break;
        }
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'gemmaAgent');
          break;
        case 'regenerate': {
          // Remove the last assistant + user entries; handleUserMessage re-adds the user turn
          const entries = this.active.entries;
          while (entries.length && entries[entries.length - 1].kind !== 'user') entries.pop();
          if (entries.length && entries[entries.length - 1].kind === 'user') entries.pop();
          this.saveStore();
          await this.handleUserMessage(msg.text as string);
          break;
        }
      }
    });

    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gemmaAgent')) this.sendCurrentSettings();
    });
    this.context.subscriptions.push(configListener);

    view.onDidDispose(() => {
      this.view = undefined;
      this.viewReady = new Promise((r) => { this.resolveViewReady = r; });
      this.sessionAutoApprove = false;
      // Resolve any approval the loop is still waiting on
      for (const resolve of this.pendingApprovals.values()) resolve('deny');
      this.pendingApprovals.clear();
      configListener.dispose();
    });

    // Initial paint
    void this.sendInitState();
    this.restoreActiveSession();
    this.resolveViewReady?.();
  }

  private async sendInitState(): Promise<void> {
    this.post({
      type: 'init',
      features: this.currentFeatures(),
      agentMode: this.agentMode,
      slashCommands: SLASH_COMMANDS.map(({ name, description }) => ({ name, description })),
    });
    this.pushBackendState();
  }

  /** Push current backend connectivity + model lists to the webview. */
  private pushBackendState(): void {
    const s = this.backend.state;
    const installedSet = new Set(s.models);
    const installedModels = s.models;
    const availableModels = s.capabilities.canListAvailable
      ? STATIC_MODELS.filter((m) => !installedSet.has(m))
      : [];
    this.post({
      type: 'backendState',
      serverState: s.serverState,
      protocol: s.protocol,
      serverInstalled: s.serverInstalled,
      capabilities: s.capabilities,
      currentModel: s.activeModel,
      installedModels,
      availableModels,
      pulls: s.pulls,
      recommendedModel: DEFAULT_MODEL,
      // legacy field still read by the current webview banner
      ollamaRunning: s.serverState === 'ready',
    });
  }

  private sendCurrentSettings(): void {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    this.post({ type: 'settingsUpdate', currentModel: cfg.get<string>('model', DEFAULT_MODEL), features: this.currentFeatures() });
  }

  private currentFeatures(): Record<string, boolean> {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    return {
      completion: cfg.get<boolean>('completionEnabled', true),
      codeActions: cfg.get<boolean>('codeActionsEnabled', true),
    };
  }

  private async toggleFeature(feature: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    const keyMap: Record<string, string> = { completion: 'completionEnabled', codeActions: 'codeActionsEnabled' };
    const key = keyMap[feature];
    if (key) await cfg.update(key, !cfg.get<boolean>(key, true), vscode.ConfigurationTarget.Global);
  }

  private async handleContextRequest(source: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.post({ type: 'contextError', message: 'No editor is open.' });
      return;
    }
    const fileName = vscode.workspace.asRelativePath(editor.document.uri);
    const lang = editor.document.languageId;

    if (source === 'selection') {
      if (editor.selection.isEmpty) {
        this.post({ type: 'contextError', message: 'Select some code in the editor first.' });
        return;
      }
      const start = editor.selection.start.line + 1;
      const end = editor.selection.end.line + 1;
      this.post({
        type: 'contextAdded',
        name: `${fileName}:${start}-${end}`,
        content: editor.document.getText(editor.selection),
        lang,
      });
    } else if (source === 'file') {
      const text = editor.document.getText();
      const MAX = 60_000;
      this.post({
        type: 'contextAdded',
        name: fileName,
        content: text.length > MAX ? text.slice(0, MAX) + '\n… (file truncated)' : text,
        lang,
      });
    }
  }

  private async handleModelChange(newModel: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    const oldModel = cfg.get<string>('model', '');

    // Update the setting immediately
    await cfg.update('model', newModel, vscode.ConfigurationTarget.Global);

    // Cancel a previous warm-up if one is in flight
    this.warmupAbort?.abort();
    this.warmupAbort = new AbortController();

    this.post({ type: 'modelLoading', model: newModel });

    try {
      // Unload the old model (if different)
      if (oldModel && oldModel !== newModel) {
        await unloadModel(oldModel);
      }
      // Pre-load the new model
      await warmupModel(newModel, this.warmupAbort.signal);
      this.post({ type: 'modelReady', model: newModel });
    } catch (err: unknown) {
      // AbortError means the user switched models again — stay silent
      if ((err as Error).name !== 'AbortError') {
        this.post({ type: 'modelWarmupFailed', model: newModel, message: describeOllamaError(err) });
      }
    }
  }

  /** Download a model with streamed progress (Ollama only). */
  private async pullModel(model: string): Promise<void> {
    if (!model) return;
    try {
      await this.backend.pull(model);
      this.post({ type: 'pullDone', model, ok: true });
    } catch (err) {
      this.post({ type: 'pullDone', model, ok: false, error: describeOllamaError(err) });
    }
  }

  /** Apply a provider preset (sets apiProtocol + ollamaUrl together). */
  private async applyProviderPreset(preset: string): Promise<void> {
    const presets: Record<string, { protocol: string; url: string }> = {
      ollama:    { protocol: 'ollama', url: 'http://localhost:11434' },
      lmstudio:  { protocol: 'openai-compatible', url: 'http://localhost:1234' },
      jan:       { protocol: 'openai-compatible', url: 'http://localhost:1337' },
      llamacpp:  { protocol: 'openai-compatible', url: 'http://localhost:8080' },
    };
    const p = presets[preset];
    if (!p) return;
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    await cfg.update('apiProtocol', p.protocol, vscode.ConfigurationTarget.Global);
    await cfg.update('ollamaUrl', p.url, vscode.ConfigurationTarget.Global);
    await this.backend.refresh();
  }

  /** Workspace file list for #file references — cached for 10 s. */
  private async sendFileList(query: string): Promise<void> {
    const now = Date.now();
    if (!this.fileListCache || now - this.fileListCache.ts > 10_000) {
      const uris = await vscode.workspace.findFiles(
        '**/*',
        '{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/build/**}',
        500
      );
      this.fileListCache = { ts: now, files: uris.map((u) => vscode.workspace.asRelativePath(u)).sort() };
    }
    const q = (query ?? '').toLowerCase();
    const files = this.fileListCache.files.filter((f) => f.toLowerCase().includes(q)).slice(0, 20);
    // Pin a #terminal entry when we have captured shell output
    const pinned: string[] = [];
    if (hasTerminalCapture() && 'terminal'.startsWith(q)) {
      pinned.push('#terminal — last command output');
    }
    this.post({ type: 'fileList', files: [...pinned, ...files] });
  }

  private attachTerminalContext(): void {
    const last = getLastExecutions()[0];
    if (!last) {
      this.post({ type: 'contextError', message: 'No terminal command has been captured yet.' });
      return;
    }
    const content = `$ ${last.command}\n(exit code ${last.exitCode})\n\n${last.output || '(no output)'}`;
    this.post({ type: 'contextAdded', name: `terminal: ${last.command.slice(0, 40)}`, content, lang: 'text' });
  }

  private async attachFileContext(relPath: string): Promise<void> {
    try {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri;
      if (!root) return;
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, relPath));
      let text = doc.getText();
      const MAX = 60_000;
      if (text.length > MAX) text = text.slice(0, MAX) + '\n… (file truncated)';
      this.post({ type: 'contextAdded', name: relPath, content: text, lang: doc.languageId });
    } catch {
      this.post({ type: 'contextError', message: `Could not read ${relPath}.` });
    }
  }

  /** Selection if present, otherwise the whole active file (60 KB cap). */
  private captureActiveEditorContext(): { name: string; content: string; lang: string } | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return undefined;
    const fileName = vscode.workspace.asRelativePath(editor.document.uri);
    const lang = editor.document.languageId;
    if (!editor.selection.isEmpty) {
      const start = editor.selection.start.line + 1;
      const end = editor.selection.end.line + 1;
      return { name: `${fileName}:${start}-${end}`, content: editor.document.getText(editor.selection), lang };
    }
    const text = editor.document.getText();
    const MAX = 60_000;
    return {
      name: fileName,
      content: text.length > MAX ? text.slice(0, MAX) + '\n… (file truncated)' : text,
      lang,
    };
  }

  async handleUserMessage(
    text: string,
    contexts?: Array<{ name: string; content: string; lang: string }>
  ): Promise<void> {
    if (!this.view) return;

    if (this.backend.state.serverState !== 'ready') {
      await this.backend.refresh();
      const st: string = this.backend.state.serverState;
      if (st !== 'ready') {
        this.postError('The local AI server is not ready. Use the setup panel above to connect a server and load a model.');
        return;
      }
    }

    // Slash commands: expand /name into its prompt template and
    // auto-attach the active selection/file when nothing was attached
    const slashMatch = /^\/(\w+)\s*([\s\S]*)$/.exec(text);
    if (slashMatch) {
      const cmd = SLASH_COMMANDS.find((c) => c.name === slashMatch[1].toLowerCase());
      if (cmd?.prompt) {
        text = slashMatch[2] ? `${cmd.prompt}\n${slashMatch[2]}` : cmd.prompt;
        if (!contexts || contexts.length === 0) {
          const auto = this.captureActiveEditorContext();
          if (auto) contexts = [auto];
        }
      }
    }

    let content = text;
    if (contexts && contexts.length > 0) {
      const parts = contexts.map(
        (c) => `**${c.name}:**\n\`\`\`${c.lang}\n${c.content}\n\`\`\``
      );
      content = `${text}\n\n${parts.join('\n\n')}`;
    }
    this.addEntry({ kind: 'user', content, ts: Date.now() });
    this.post({ type: 'userMessage', text: content });
    this.post({ type: 'startAssistant' });
    this.activeAbort = new AbortController();

    if (this.agentMode) await this.runAgent(content);
    else await this.runChat();
  }

  private async runChat(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    const budget = computeBudget(cfg.get<number>('numCtx', 8192), cfg.get<number>('maxTokens', 4096));
    // Trim a copy — the session entries keep the full transcript for the UI/storage
    const systemPrompt = CHAT_SYSTEM_PROMPT + getInstructionSuffix();
    const { messages, droppedCount } = fitMessages(
      [{ role: 'system', content: systemPrompt }, ...this.llmHistory()],
      budget
    );
    if (droppedCount > 0) this.post({ type: 'contextTrimmed', count: droppedCount });

    let response = '';
    try {
      for await (const chunk of ollamaChat({
        messages,
        signal: this.activeAbort!.signal,
      })) {
        response += chunk;
        this.post({ type: 'chunk', text: chunk });
      }

      if (!response.trim()) {
        this.postError(
          `The model returned an empty response.\n` +
          `• Current model: ${cfg.get('model')}\n` +
          `• Is this model installed? Check the model picker.`
        );
      } else {
        this.addEntry({ kind: 'assistant', content: response, ts: Date.now() });
      }
      this.post({ type: 'endAssistant' });
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        // Keep whatever streamed before the user pressed Stop
        if (response.trim()) this.addEntry({ kind: 'assistant', content: response, ts: Date.now() });
      } else {
        this.postError(describeOllamaError(err));
      }
      this.post({ type: 'endAssistant' });
    }
  }

  private confirmTool(_call: ToolCall, callId: string): Promise<'approve' | 'deny'> {
    if (this.sessionAutoApprove) return Promise.resolve('approve');
    return new Promise((resolve) => {
      const signal = this.activeAbort?.signal;
      const onAbort = () => { cleanup(); resolve('deny'); };
      const cleanup = () => {
        this.pendingApprovals.delete(callId);
        signal?.removeEventListener('abort', onAbort);
      };
      this.pendingApprovals.set(callId, (d) => { cleanup(); resolve(d); });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async undoLastCheckpoint(): Promise<void> {
    const checkpoint = this.lastCheckpoint;
    if (!checkpoint) return;
    this.lastCheckpoint = undefined;
    const { restored, failed } = await checkpoint.restore();
    this.post({ type: 'checkpointRestored', restored, failed });
    if (failed.length > 0) {
      this.postError(`Could not restore: ${failed.join(', ')}`);
    }
  }

  private async runAgent(content: string): Promise<void> {
    // History before the just-added user turn (the loop takes the user msg separately)
    const historyWithoutLast = this.llmHistory().slice(0, -1);
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    const maxIterations = cfg.get<number>('agentMaxIterations', 10);

    const checkpoint = new Checkpoint();
    this.lastCheckpoint = checkpoint;
    const hooks: AgentHooks = {
      confirmTool: (call, callId) => this.confirmTool(call, callId),
      beforeFileMutation: (relPath) => checkpoint.snapshot(relPath),
    };

    let fullResponse = '';
    try {
      for await (const event of runAgentLoop(content, historyWithoutLast, this.activeAbort!.signal, maxIterations, hooks)) {
        switch (event.type) {
          case 'text':          fullResponse += event.text; this.post({ type: 'chunk', text: event.text! }); break;
          case 'tool_call':
            this.pendingToolEntry = {
              tool: event.tool!.tool,
              arg: String(event.tool!.path ?? event.tool!.command ?? event.tool!.query ?? ''),
            };
            this.post({
              type: 'toolCall',
              tool: event.tool!,
              callId: event.callId,
              requiresApproval: !!event.requiresApproval && !this.sessionAutoApprove,
            });
            break;
          case 'tool_result':
            this.post({ type: 'toolResult', result: event.result!, callId: event.callId });
            if (this.pendingToolEntry) {
              this.addEntry({
                kind: 'tool',
                tool: this.pendingToolEntry.tool,
                arg: this.pendingToolEntry.arg,
                ok: !!event.result?.ok,
                output: event.result?.output ?? '',
                ts: Date.now(),
              });
              this.pendingToolEntry = undefined;
            }
            break;
          case 'agentThinking': this.post({ type: 'agentThinking', iteration: event.iteration, maxIterations: event.maxIterations }); break;
          case 'warning':       this.post({ type: 'notice', text: event.text }); this.addEntry({ kind: 'notice', text: event.text ?? '', ts: Date.now() }); break;
          case 'error':         this.postError(event.text!); break;
        }
      }
      if (fullResponse.trim()) this.addEntry({ kind: 'assistant', content: fullResponse, ts: Date.now() });
      this.post({ type: 'endAssistant' });
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        if (fullResponse.trim()) this.addEntry({ kind: 'assistant', content: fullResponse, ts: Date.now() });
      } else {
        this.postError(describeOllamaError(err));
      }
      this.post({ type: 'endAssistant' });
    }

    if (checkpoint.files.length > 0) {
      this.post({ type: 'checkpointAvailable', checkpointId: checkpoint.id, files: checkpoint.files });
    }
  }

  async sendToChat(prompt: string, code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const lang = editor?.document.languageId ?? 'code';
    const fileName = editor ? vscode.workspace.asRelativePath(editor.document.uri) : 'selection';
    this.openOrFocus();
    // Wait for the view to resolve so the message isn't dropped on first open
    await Promise.race([
      this.viewReady ?? Promise.resolve(),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    await this.handleUserMessage(prompt, [{ name: fileName, content: code, lang }]);
  }

  private insertCodeToEditor(code: string): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) editor.edit((eb) => eb.replace(editor.selection, code));
  }

  private post(msg: Record<string, unknown>): void { this.view?.webview.postMessage(msg); }
  private postError(message: string): void { this.post({ type: 'error', text: message }); }

  private buildHtml(webview: vscode.Webview): string {
    const scriptUri = getWebviewUri(webview, this.extensionUri, ['media', 'chat.js']);
    const styleUri  = getWebviewUri(webview, this.extensionUri, ['media', 'chat.css']);
    const nonce = getNonce();
    return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${webview.cspSource} 'unsafe-inline';
             script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Gemma Agent</title>
</head>
<body>
  <div id="header">
    <div id="headerIcon">G</div>
    <span id="headerTitle">Gemma Agent</span>
    <button id="modelBadge" title="Choose model">…</button>
    <div id="headerActions">
      <button class="icon-btn" id="sessionsBtn" title="Chat sessions">☰</button>
      <button class="icon-btn" id="newChatBtn" title="New chat">＋</button>
      <button class="icon-btn" id="refreshBtn" title="Refresh installed models">⟳</button>
      <button class="icon-btn" id="stopOllamaBtn" title="Stop Ollama">⏹</button>
      <button class="icon-btn" id="clearBtn" title="Clear this conversation">🗑</button>
    </div>
  </div>

  <div id="modelPopover"></div>
  <div id="sessionPopover"></div>

  <div id="pillBar">
    <button class="pill" data-feature="completion" title="Ghost text inline completions">Completion</button>
    <button class="pill" data-feature="codeActions" title="Right-click: Explain, Refactor, Test">Code Actions</button>
    <button class="pill agent-pill" id="agentPill" title="Create files, edit, run commands">⚡ Agent</button>
  </div>

  <div id="setupView"></div>

  <div id="messagesWrapper">
    <div id="messages">
      <div id="emptyState">
        <div class="empty-icon">✦</div>
        <div class="empty-title">Gemma Agent</div>
        <div class="empty-sub">Write, explain, fix code or use ⚡ Agent mode to create files.</div>
      </div>
    </div>
    <button id="scrollToBottomBtn" title="Scroll to bottom">↓</button>
  </div>

  <div id="inputArea">
    <div id="contextChips"></div>
    <div id="inputWrapper">
      <button class="icon-btn" id="attachBtn" title="Attach file or selection">⊕</button>
      <textarea id="input" rows="1" placeholder="Message… (Enter to send, Shift+Enter for newline)"></textarea>
      <button id="sendBtn" title="Send">↑</button>
      <button id="stopBtn" style="display:none" title="Stop">◼</button>
    </div>
    <div id="attachMenu">
      <button class="attach-opt" data-source="file">📄 Active file</button>
      <button class="attach-opt" data-source="selection">✂ Selected code</button>
    </div>
    <div id="inputHint">
      <span id="modeLabel">Chat</span>
      <span id="inputHintSpacer"></span>
      <span>Enter ↵</span>
    </div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
