import * as vscode from 'vscode';
import { DEFAULT_MODEL, OllamaMessage, describeOllamaError, isOllamaRunning, listModels, ollamaChat, unloadModel, warmupModel } from '../ollama/client';
import { computeBudget, fitMessages } from '../ollama/contextWindow';
import { AgentHooks, runAgentLoop } from '../agent/agentLoop';
import { Checkpoint } from '../agent/checkpoints';
import { ToolCall } from '../agent/tools';
import { getNonce, getWebviewUri } from '../webview/utils';

const STATIC_MODELS = ['gemma4:e4b', 'gemma4:e2b', 'gemma4:9b', 'gemma4:12b', 'gemma4:27b', 'gemma3:1b', 'gemma3:4b', 'gemma3:12b', 'gemma3:27b', 'gemma3n:e2b', 'gemma3n:e4b'];

// ── Persisted chat history ──────────────────────────────────
const HISTORY_KEY = 'gemmaAgent.chatHistory.v1';
const MAX_PERSISTED_MESSAGES = 80;
const MAX_PERSISTED_BYTES = 512 * 1024;

interface PersistedMessage { role: 'user' | 'assistant'; content: string; ts: number }
interface PersistedChat { version: 1; savedAt: number; messages: PersistedMessage[] }

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

export class GemmaChatProvider {
  private panel?: vscode.WebviewPanel;
  private history: OllamaMessage[] = [];
  private activeAbort?: AbortController;
  private warmupAbort?: AbortController;
  private agentMode = false;
  private readonly extensionUri: vscode.Uri;
  private readonly pendingApprovals = new Map<string, (d: 'approve' | 'deny') => void>();
  private sessionAutoApprove = false;
  private lastCheckpoint?: Checkpoint;
  private fileListCache?: { ts: number; files: string[] };

  constructor(private readonly context: vscode.ExtensionContext) {
    this.extensionUri = context.extensionUri;
    this.history = this.loadHistory();
  }

  // ── History persistence ─────────────────────────────────
  private loadHistory(): OllamaMessage[] {
    const saved = this.context.workspaceState.get<PersistedChat>(HISTORY_KEY);
    if (!saved || saved.version !== 1 || !Array.isArray(saved.messages)) return [];
    return saved.messages
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .map((m) => ({ role: m.role, content: m.content }));
  }

  private saveHistory(): void {
    const now = Date.now();
    let msgs: PersistedMessage[] = this.history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content, ts: now }));
    if (msgs.length > MAX_PERSISTED_MESSAGES) msgs = msgs.slice(-MAX_PERSISTED_MESSAGES);
    // Enforce the byte cap by dropping the oldest pairs
    while (msgs.length > 2 && JSON.stringify(msgs).length > MAX_PERSISTED_BYTES) {
      msgs = msgs.slice(2);
    }
    const data: PersistedChat = { version: 1, savedAt: now, messages: msgs };
    void this.context.workspaceState.update(HISTORY_KEY, data);
  }

  private clearStoredHistory(): void {
    void this.context.workspaceState.update(HISTORY_KEY, undefined);
  }

  /** Open panel if not open, or bring it to front. */
  openOrFocus(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      'gemmaAgent.chat',
      'Gemma Agent',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
      }
    );

    this.panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    this.panel.webview.html = this.buildHtml(this.panel.webview);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case 'sendMessage':   await this.handleUserMessage(msg.text, msg.contexts); break;
        case 'clearHistory':
          this.history = [];
          this.clearStoredHistory();
          this.sessionAutoApprove = false;
          break;
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
        case 'refreshModels': await this.sendInitState(); break;
        case 'stopOllama':
          await vscode.commands.executeCommand('gemmaAgent.stopOllama');
          await this.sendInitState();
          break;
        case 'pullModel':
          await vscode.commands.executeCommand('gemmaAgent.pullModel', msg.model);
          break;
        case 'startOllama':
          await vscode.commands.executeCommand('gemmaAgent.startOllama');
          // Command itself polls for readiness; refresh UI once it returns
          await this.sendInitState();
          break;
        case 'regenerate':
          // Remove the last assistant + user pair; handleUserMessage re-adds the user turn
          if (this.history.length >= 2 && this.history[this.history.length - 1].role === 'assistant') {
            this.history.pop();
            if (this.history[this.history.length - 1]?.role === 'user') this.history.pop();
            this.saveHistory();
          }
          await this.handleUserMessage(msg.text as string);
          break;
      }
    });

    const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gemmaAgent')) this.sendCurrentSettings();
    });

    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.sessionAutoApprove = false;
      // Resolve any approval the loop is still waiting on
      for (const resolve of this.pendingApprovals.values()) resolve('deny');
      this.pendingApprovals.clear();
      configListener.dispose();
    });

    setTimeout(async () => {
      await this.sendInitState();
      if (this.history.length > 0) {
        this.post({ type: 'history', messages: this.history });
      }
    }, 150);
  }

  private async sendInitState(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    const currentModel = cfg.get<string>('model', DEFAULT_MODEL);
    const running = await isOllamaRunning();
    const fetched = running ? await listModels() : [];

    const installedSet = new Set(fetched);
    const installedModels = fetched.filter((m) => m.includes('gemma'));
    // Models in static list that are NOT installed
    const availableModels = STATIC_MODELS.filter((m) => !installedSet.has(m));

    this.post({
      type: 'init',
      installedModels,
      availableModels,
      currentModel,
      features: this.currentFeatures(),
      ollamaRunning: running,
      agentMode: this.agentMode,
      slashCommands: SLASH_COMMANDS.map(({ name, description }) => ({ name, description })),
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
    this.post({ type: 'fileList', files });
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
    if (!this.panel) return;

    const running = await isOllamaRunning();
    if (!running) { this.postError('Ollama is not running. Click ▶ Start in the banner above or run `ollama serve`.'); return; }

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
    this.history.push({ role: 'user', content });
    this.post({ type: 'userMessage', text: content });
    this.post({ type: 'startAssistant' });
    this.activeAbort = new AbortController();

    if (this.agentMode) await this.runAgent(content);
    else await this.runChat();
  }

  private async runChat(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    const budget = computeBudget(cfg.get<number>('numCtx', 8192), cfg.get<number>('maxTokens', 4096));
    // Trim a copy — this.history keeps the full transcript for the UI and storage
    const { messages, droppedCount } = fitMessages(
      [{ role: 'system', content: CHAT_SYSTEM_PROMPT }, ...this.history],
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
          `• Is this model installed in Ollama? Check with: ollama list`
        );
      } else {
        this.history.push({ role: 'assistant', content: response });
      }
      this.post({ type: 'endAssistant' });
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        // Keep whatever streamed before the user pressed Stop
        if (response.trim()) this.history.push({ role: 'assistant', content: response });
      } else {
        this.postError(describeOllamaError(err));
      }
      this.post({ type: 'endAssistant' });
    }
    this.saveHistory();
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
    const historyWithoutLast = this.history.slice(0, -1);
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
            this.post({
              type: 'toolCall',
              tool: event.tool!,
              callId: event.callId,
              requiresApproval: !!event.requiresApproval && !this.sessionAutoApprove,
            });
            break;
          case 'tool_result':   this.post({ type: 'toolResult', result: event.result!, callId: event.callId }); break;
          case 'agentThinking': this.post({ type: 'agentThinking', iteration: event.iteration, maxIterations: event.maxIterations }); break;
          case 'warning':       this.post({ type: 'notice', text: event.text }); break;
          case 'error':         this.postError(event.text!); break;
        }
      }
      this.history.push({ role: 'assistant', content: fullResponse });
      this.post({ type: 'endAssistant' });
    } catch (err: unknown) {
      if ((err as Error).name === 'AbortError') {
        if (fullResponse.trim()) this.history.push({ role: 'assistant', content: fullResponse });
      } else {
        this.postError(describeOllamaError(err));
      }
      this.post({ type: 'endAssistant' });
    }
    this.saveHistory();

    if (checkpoint.files.length > 0) {
      this.post({ type: 'checkpointAvailable', checkpointId: checkpoint.id, files: checkpoint.files });
    }
  }

  async sendToChat(prompt: string, code: string): Promise<void> {
    this.openOrFocus();
    await new Promise((r) => setTimeout(r, 350));
    const editor = vscode.window.activeTextEditor;
    const lang = editor?.document.languageId ?? 'code';
    const fileName = editor ? vscode.workspace.asRelativePath(editor.document.uri) : 'selection';
    await this.handleUserMessage(prompt, [{ name: fileName, content: code, lang }]);
  }

  private insertCodeToEditor(code: string): void {
    const editor = vscode.window.activeTextEditor;
    if (editor) editor.edit((eb) => eb.replace(editor.selection, code));
  }

  private post(msg: Record<string, unknown>): void { this.panel?.webview.postMessage(msg); }
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
      <button class="icon-btn" id="refreshBtn" title="Refresh installed models">⟳</button>
      <button class="icon-btn" id="stopOllamaBtn" title="Stop Ollama">⏹</button>
      <button class="icon-btn" id="clearBtn" title="Clear chat history">🗑</button>
    </div>
  </div>

  <div id="modelPopover"></div>

  <div id="pillBar">
    <button class="pill" data-feature="completion" title="Ghost text inline completions">Completion</button>
    <button class="pill" data-feature="codeActions" title="Right-click: Explain, Refactor, Test">Code Actions</button>
    <button class="pill agent-pill" id="agentPill" title="Create files, edit, run commands">⚡ Agent</button>
  </div>

  <div id="ollamaBanner">
    <span id="ollamaStatus">⚠ Ollama not running</span>
    <button id="startOllamaBtn">▶ Start</button>
  </div>

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
