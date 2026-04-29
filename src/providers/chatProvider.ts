import * as vscode from 'vscode';
import { OllamaMessage, isOllamaRunning, listModels, ollamaChat, unloadModel, warmupModel } from '../ollama/client';
import { runAgentLoop } from '../agent/agentLoop';
import { getNonce, getWebviewUri } from '../webview/utils';

const STATIC_MODELS = ['gemma4:e4b', 'gemma4:e2b', 'gemma4:9b', 'gemma4:12b', 'gemma4:27b', 'gemma3:1b', 'gemma3:4b', 'gemma3:12b', 'gemma3:27b', 'gemma3n:e2b', 'gemma3n:e4b'];

export class GemmaChatProvider {
  private panel?: vscode.WebviewPanel;
  private history: OllamaMessage[] = [];
  private activeAbort?: AbortController;
  private warmupAbort?: AbortController;
  private agentMode = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

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
        case 'clearHistory':  this.history = []; break;
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
      }
    });

    this.panel.onDidDispose(() => { this.panel = undefined; });

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('gemmaAgent')) this.sendCurrentSettings();
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
    const currentModel = cfg.get<string>('model', 'gemma4:e4b');
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
    });
  }

  private sendCurrentSettings(): void {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    this.post({ type: 'settingsUpdate', currentModel: cfg.get<string>('model', 'gemma4:e4b'), features: this.currentFeatures() });
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
      this.post({ type: 'contextError', message: 'Açık bir editör yok.' });
      return;
    }
    const fileName = vscode.workspace.asRelativePath(editor.document.uri);
    const lang = editor.document.languageId;

    if (source === 'selection') {
      if (editor.selection.isEmpty) {
        this.post({ type: 'contextError', message: 'Önce editörde kod seçin.' });
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
        content: text.length > MAX ? text.slice(0, MAX) + '\n… (dosya kırpıldı)' : text,
        lang,
      });
    }
  }

  private async handleModelChange(newModel: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    const oldModel = cfg.get<string>('model', '');

    // Ayarı hemen güncelle
    await cfg.update('model', newModel, vscode.ConfigurationTarget.Global);

    // Önceki warm-up varsa iptal et
    this.warmupAbort?.abort();
    this.warmupAbort = new AbortController();

    this.post({ type: 'modelLoading', model: newModel });

    try {
      // Eski modeli boşalt (farklıysa)
      if (oldModel && oldModel !== newModel) {
        await unloadModel(oldModel);
      }
      // Yeni modeli önceden yükle
      await warmupModel(newModel, this.warmupAbort.signal);
      this.post({ type: 'modelReady', model: newModel });
    } catch (err: unknown) {
      // Kullanıcı tekrar model değiştirdiyse abort gelir — sessizce geç
      if ((err as Error).name !== 'AbortError') {
        this.post({ type: 'modelReady', model: newModel }); // hata olsa da badge'i resetle
      }
    }
  }

  async handleUserMessage(
    text: string,
    contexts?: Array<{ name: string; content: string; lang: string }>
  ): Promise<void> {
    if (!this.panel) return;

    const running = await isOllamaRunning();
    if (!running) { this.postError('Ollama çalışmıyor. `ollama serve` komutunu çalıştırın.'); return; }

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
    let response = '';
    try {
      for await (const chunk of ollamaChat({
        messages: [
          {
            role: 'system',
            content:
              'Sen bir yazılım geliştirme asistanısın. Türkçe yanıt ver.\n' +
              'Kurallar:\n' +
              '- Kısa ve öz ol. Uzun giriş paragrafları yazma.\n' +
              '- Kod bloklarını her zaman ```dil ... ``` formatında yaz ve MUTLAKA kapat.\n' +
              '- Açıklama gerekiyorsa kodu yazdıktan SONRA yaz.\n' +
              '- Birden fazla seçenek sunma, en iyi çözümü doğrudan ver.',
          },
          ...this.history,
        ],
        signal: this.activeAbort!.signal,
      })) {
        response += chunk;
        this.post({ type: 'chunk', text: chunk });
      }

      if (!response.trim()) {
        this.postError(
          `Model boş yanıt döndürdü.\n` +
          `• Kullanılan model: ${vscode.workspace.getConfiguration('gemmaAgent').get('model')}\n` +
          `• Ollama'da bu model yüklü mü? Kontrol için: ollama list`
        );
      } else {
        this.history.push({ role: 'assistant', content: response });
      }
      this.post({ type: 'endAssistant' });
    } catch (err: unknown) {
      const e = err as Error;
      if (e.name !== 'AbortError') {
        this.postError(`Ollama bağlantı hatası: ${e.message}`);
      }
      this.post({ type: 'endAssistant' });
    }
  }

  private async runAgent(content: string): Promise<void> {
    const historyWithoutLast = this.history.slice(0, -1);
    let fullResponse = '';
    try {
      for await (const event of runAgentLoop(content, historyWithoutLast, this.activeAbort!.signal)) {
        switch (event.type) {
          case 'text':        fullResponse += event.text; this.post({ type: 'chunk', text: event.text! }); break;
          case 'tool_call':   this.post({ type: 'toolCall', tool: event.tool! }); break;
          case 'tool_result': this.post({ type: 'toolResult', result: event.result! }); break;
          case 'error':       this.postError(event.text!); break;
        }
      }
      this.history.push({ role: 'assistant', content: fullResponse });
      this.post({ type: 'endAssistant' });
    } catch (err: unknown) {
      if ((err as Error).name !== 'AbortError') this.postError((err as Error).message);
      this.post({ type: 'endAssistant' });
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
<html lang="tr">
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
    <button id="modelBadge" title="Model seç">gemma4:e4b</button>
    <div id="headerActions">
      <button class="icon-btn" id="refreshBtn" title="Yüklü modelleri yenile">⟳</button>
      <button class="icon-btn" id="stopOllamaBtn" title="Ollama'yı durdur">⏹</button>
      <button class="icon-btn" id="clearBtn" title="Sohbet geçmişini sil">🗑</button>
    </div>
  </div>

  <div id="modelPopover"></div>

  <div id="pillBar">
    <button class="pill" data-feature="completion" title="Ghost text kod tamamlama">Tamamlama</button>
    <button class="pill" data-feature="codeActions" title="Sağ tık: Açıkla, Refactor, Test">Kod Eylemleri</button>
    <button class="pill agent-pill" id="agentPill" title="Dosya oluştur, düzenle, komut çalıştır">⚡ Agent</button>
  </div>

  <div id="ollamaBanner">
    <span id="ollamaStatus">⚠ Ollama çalışmıyor</span>
    <button id="startOllamaBtn">▶ Başlat</button>
  </div>

  <div id="messages">
    <div id="emptyState">
      <div class="empty-icon">✦</div>
      <div class="empty-title">Gemma Agent</div>
      <div class="empty-sub">Kod yaz, açıkla, düzelt ya da ⚡ Agent modunda dosya oluştur.</div>
    </div>
  </div>

  <div id="inputArea">
    <div id="contextChips"></div>
    <div id="inputWrapper">
      <button class="icon-btn" id="attachBtn" title="Dosya veya seçili kod ekle">⊕</button>
      <textarea id="input" rows="1" placeholder="Mesaj yaz… (Enter gönder, Shift+Enter yeni satır)"></textarea>
      <button id="sendBtn" title="Gönder">↑</button>
      <button id="stopBtn" style="display:none" title="Durdur">◼</button>
    </div>
    <div id="attachMenu">
      <button class="attach-opt" data-source="file">📄 Aktif dosya</button>
      <button class="attach-opt" data-source="selection">✂ Seçili kod</button>
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
