# Gemma Agent — Tam Teknik Spesifikasyon

## 1. Genel Bakış

Gemma Agent, VS Code içinde Ollama aracılığıyla yerel Gemma modellerini kullanan, internet bağlantısı gerektirmeyen bir AI kodlama asistanıdır. Kullanıcı verisi hiçbir zaman dış sunucuya gönderilmez.

**Temel Özellikler:**
- Sohbet paneli (WebviewPanel tabanlı)
- Inline kod tamamlama (debounce: 600ms varsayılan)
- Seçili kod üzerinde inline düzenleme (diff önizlemeli)
- Sağ tık kod aksiyonları (explain / refactor / fix / test)
- Terminal entegrasyonu
- Ajansal dosya düzenleme (XML tool-call döngüsü)

---

## 2. Mimari

### 2.1 Katmanlar

```
VS Code Extension Host
│
├── extension.ts          ← Aktivasyon, komut kaydı, provider init, Ollama lifecycle
│
├── Providers (VS Code API ile entegrasyon)
│   ├── ChatProvider          ← WebviewPanel (createWebviewPanel), openOrFocus()
│   ├── CompletionProvider    ← InlineCompletionItemProvider
│   ├── InlineEditProvider    ← Seçim bazlı düzenleme + diff önizleme
│   ├── CodeActionProvider    ← CodeActionProvider (lightbulb)
│   └── TerminalProvider      ← Terminal komut çalıştırma
│
├── Agent (otonom görev yürütme)
│   ├── agentLoop.ts          ← XML tool-call döngüsü, agentThinking eventi
│   └── tools.ts              ← Dosya okuma/yazma/düzenleme, komut çalıştırma
│
├── Ollama Client
│   └── client.ts             ← Modül-seviyesi fonksiyonlar (sınıf değil)
│
└── Webview UI
    ├── media/chat.js     ← Vanilla JS, RAF-batched streaming
    └── media/chat.css    ← VS Code tema değişkenleriyle uyumlu stil
```

### 2.2 Veri Akışı — Chat

```
Kullanıcı mesaj yazar
    → media/chat.js (vscode.postMessage {type:'sendMessage', text, contexts})
    → ChatProvider.handleUserMessage()
    → ollamaChat({messages, signal})   ← src/ollama/client.ts
    → Ollama /api/chat (NDJSON streaming)
    → Her chunk: postMessage({type:'chunk', text})
    → chat.js: scheduleChunk() → requestAnimationFrame → DOM güncellenir
    → Bitti: postMessage({type:'endAssistant'})
```

### 2.3 Veri Akışı — Agent Döngüsü

```
Kullanıcı agent görevi verir
    → ChatProvider.runAgent()
    → agentLoop.ts: runAgentLoop() generator başlar
        └── Her iterasyonda:
            1. yield {type:'agentThinking', iteration, maxIterations}
            2. ollamaChat() ile LLM yanıtı toplanır
            3. <tool_call>...</tool_call> bloğu aranır
            4. Bulunamazsa: yield {type:'done'} → loop biter
            5. Bulunursa:
               - yield {type:'tool_call', tool}
               - executeTool(toolCall) çalışır
               - yield {type:'tool_result', result}
               - Sonuç messages[] dizisine eklenir, döngü devam eder
    → agentMaxIterations dolunca: yield {type:'done'}
```

---

## 3. Provider Detayları

### 3.1 ChatProvider (`src/providers/chatProvider.ts`)

- `vscode.window.createWebviewPanel()` ile panel açar (**`WebviewViewProvider` değil**)
- `openOrFocus()`: panel yoksa oluşturur, varsa öne getirir
- `panel.webview.onDidReceiveMessage()` ile kullanıcı mesajlarını alır
- `onDidChangeConfiguration` listener panelin kendisine bağlı — panel kapanınca dispose edilir (bellek sızıntısı önlendi)
- Konuşma geçmişi `this.history: OllamaMessage[]` içinde tutulur
- Panel yeniden açıldığında `{type:'history', messages}` ile geçmiş restore edilir
- Agent modu: `this.agentMode` boolean, `runAgent()` / `runChat()` dallanması

### 3.2 CompletionProvider (`src/providers/completionProvider.ts`)

- `InlineCompletionItemProvider` implement eder
- `gemmaAgent.completionEnabled` false ise null döner
- Debounce süresi: `gemmaAgent.completionDebounceMs` (default: 600ms)
- Bağlam: 60 satır prefix + 20 satır suffix
- Token limiti: `gemmaAgent.completionMaxTokens` (default: 150)
- Önceki istek abort edilir, yeni istek başlatılır
- Post-processing: markdown fence temizleme, filler satır kaldırma, sadece gerçek prosa paragraflarını keser

### 3.3 InlineEditProvider (`src/providers/inlineEditProvider.ts`)

- Seçili kodu + instruction'ı Ollama'ya gönderir (`ollamaGenerate`)
- **Diff önizlemesi**: `gemma-proposed` scheme'li virtual document + `vscode.diff` komutu
- Kullanıcı "Apply" demeden hiçbir şey değişmez
- Uygulama `WorkspaceEdit` ile yapılır (undo stack doğru çalışır)
- `ctrl+shift+i` / `cmd+shift+i` kısayolu

### 3.4 CodeActionProvider (`src/providers/codeActionProvider.ts`)

- `gemmaAgent.codeActionsEnabled` false ise devre dışı
- Sağ tık menüsüne 5 aksiyon ekler: explain, refactor, fix, generateTests, inlineEdit
- Her aksiyon seçili kodu `chatProvider.sendToChat()` üzerinden sohbet paneline gönderir

### 3.5 TerminalProvider (`src/providers/terminalProvider.ts`)

- `gemmaAgent.runInTerminal` komutunu karşılar
- Seçili kodu veya aktif dosyayı terminalde çalıştırır / açıklar

---

## 4. Agent Sistemi

### 4.1 agentLoop.ts

ReAct benzeri döngü. LLM'den **XML wrapper içinde JSON** formatında tool çağrısı bekler:

```
<tool_call>
{"tool":"read_file","path":"src/extension.ts"}
</tool_call>
```

Tool çağrısı yoksa (düz metin yanıt) döngü biter (`{type:'done'}`).

**Önemli:** `{"action":"..."}` formatı kullanılmaz. Key her zaman `"tool"`. `final_answer` aksiyonu yoktur — model sadece düz metin yazarsa döngü otomatik biter.

Parser 3-geçişli: standart `JSON.parse` → literal newline repair → regex fallback.

`agentMaxIterations` (default: 10, max: 30) aşılırsa döngü durur.

**Emitted events:**

| Event | Ne zaman |
|---|---|
| `agentThinking` | Her iterasyon başında (iteration, maxIterations içerir) |
| `tool_call` | Tool parse edilip execute edilmeden önce |
| `tool_result` | Execute sonrası (ok, output içerir) |
| `text` | LLM'in tool olmayan metin çıktısı |
| `done` | Döngü başarıyla bitti |
| `error` | Hata oluştu |

### 4.2 tools.ts — Araçlar

| Araç | JSON key'ler | Açıklama |
|---|---|---|
| `read_file` | `path` | Dosya okur (max 500 KB, max 300 satır önizleme) |
| `create_file` | `path`, `content` | Dosya oluşturur veya üzerine yazar |
| `edit_file` | `path`, `search`, `replace` | Tam metin eşleşmesiyle değiştirir (CRLF normalize) |
| `run_command` | `command` | Shell komutu çalıştırır, stdout+stderr döner (max 4 KB) |
| `list_files` | `path` | Dizin içeriğini listeler |
| `search_files` | `query`, `path?` | Workspace'te metin arar (max 30 dosya) |

**Güvenlik:** `resolveUri()` workspace dışına çıkan path'leri reddeder.

---

## 5. Ollama Client (`src/ollama/client.ts`)

Modül-seviyesi export fonksiyonları — sınıf instance'ı **değil**.

```typescript
// Sohbet (geçmişle, streaming AsyncGenerator)
ollamaChat({ messages, signal }): AsyncGenerator<string>

// Tek seferlik üretim (completion, inline edit)
ollamaGenerate({ prompt, system, maxTokens, signal }): Promise<string>

// Model yönetimi
listModels(): Promise<string[]>
isOllamaRunning(): Promise<boolean>
unloadModel(model: string): Promise<void>      // keep_alive: 0
warmupModel(model: string, signal): Promise<void>
```

### Streaming

`ollamaChat` NDJSON stream döner, her satır `JSON.parse` edilir, `response` alanı yield edilir. `done: true` gelince generator biter.

---

## 6. Webview UI

### Mesajlaşma Protokolü (extension ↔ webview)

**Webview → Extension:**

| type | payload | Açıklama |
|---|---|---|
| `sendMessage` | `text`, `contexts?` | Kullanıcı mesajı gönderir |
| `clearHistory` | — | Sohbet geçmişini siler |
| `stopGeneration` | — | Aktif isteği iptal eder |
| `insertCode` | `code` | Kodu aktif editöre yapıştırır |
| `changeModel` | `model` | Model değiştirir |
| `toggleFeature` | `feature` | completion / codeActions toggle |
| `requestContext` | `source` | file / selection bağlamı ister |
| `toggleAgentMode` | — | Agent modunu açar/kapatır |
| `refreshModels` | — | Yüklü modelleri yeniler |
| `startOllama` | — | Ollama'yı başlatır |
| `stopOllama` | — | Ollama'yı durdurur |
| `pullModel` | `model` | ollama pull başlatır |
| `regenerate` | `text` | Son yanıtı yeniden üretir |

**Extension → Webview:**

| type | payload | Açıklama |
|---|---|---|
| `init` | `installedModels`, `availableModels`, `currentModel`, `features`, `ollamaRunning`, `agentMode` | İlk yükleme |
| `settingsUpdate` | `currentModel`, `features` | Ayar değiştiğinde |
| `modelLoading` | `model` | Model warm-up başladı |
| `modelReady` | `model` | Model hazır |
| `agentMode` | `enabled` | Agent modu değişti |
| `userMessage` | `text` | Kullanıcı mesajı (geçmişten) |
| `startAssistant` | — | Yanıt başladı |
| `chunk` | `text` | Streaming token |
| `toolCall` | `tool` | Agent tool çağrısı başladı |
| `toolResult` | `result` | Tool tamamlandı |
| `agentThinking` | `iteration`, `maxIterations` | Agent düşünüyor göstergesi |
| `endAssistant` | — | Yanıt bitti |
| `error` | `text` | Hata mesajı |
| `history` | `messages` | Panel yeniden açıldığında geçmiş |
| `contextAdded` | `name`, `content`, `lang` | Context chip eklendi |
| `contextError` | `message` | Context isteği başarısız |

### Rendering

- **Streaming**: RAF (`requestAnimationFrame`) batching — her frame'de birikmiş chunk'lar tek seferde render edilir
- **Syntax highlighting**: Vanilla JS state machine tokenizer (Python, JS/TS, C/C++, Go, Rust, Java, C#, Bash)
- **Markdown**: Code block'lar `highlight()` ile renklendirilir; inline: backtick, bold, italic, başlıklar

---

## 7. Konfigürasyon Referansı (Tam Liste)

| Anahtar | Tip | Default | Açıklama |
|---|---|---|---|
| `gemmaAgent.ollamaUrl` | string | `http://localhost:11434` | Ollama sunucu adresi |
| `gemmaAgent.model` | enum | `gemma4:e4b` | Kullanılan model |
| `gemmaAgent.completionEnabled` | boolean | `true` | Inline completion aktif/pasif |
| `gemmaAgent.completionDebounceMs` | number | `600` | Completion tetikleme gecikmesi (ms) |
| `gemmaAgent.completionMaxTokens` | number | `150` | Completion max token (32–512) |
| `gemmaAgent.maxTokens` | number | `4096` | Chat max token |
| `gemmaAgent.codeActionsEnabled` | boolean | `true` | Lightbulb menüsü aktif/pasif |
| `gemmaAgent.ollamaOnExit` | enum | `keep` | Çıkışta Ollama davranışı (ask/keep/stop) |
| `gemmaAgent.agentMaxIterations` | number | `10` | Agent max iterasyon (1–30) |

---

## 8. Geliştirme Notları

### Yeni Komut Ekleme

1. `package.json` → `contributes.commands` dizisine ekle
2. `package.json` → `contributes.menus` veya `keybindings`'e ekle
3. `src/extension.ts`'te `vscode.commands.registerCommand` ile kaydet
4. İlgili provider'a logic ekle veya yeni provider oluştur

### Yeni Agent Tool Ekleme

1. `src/agent/tools.ts`'te `ToolName` union'ına yeni isim ekle
2. Araç fonksiyonunu yaz
3. `executeTool()` switch'ine case ekle
4. `AGENT_SYSTEM_PROMPT` içindeki araç listesini güncelle

### Yeni Model Desteği

- `package.json` → `gemmaAgent.model` enum dizisine ekle
- Client tarafında değişiklik gerekmez (model adı string olarak geçer)

### Build & Test

```bash
npm run compile    # TypeScript derle
npm run watch      # Watch mode
npm run lint       # ESLint (src/**/*.ts)
# F5 → VS Code Extension Development Host başlatır
```

---

## 9. Bilinen Kısıtlamalar & Gelecek İyileştirmeler

- [ ] Konuşma geçmişi session'lar arası kalıcı değil — `vscode.ExtensionContext.globalState` ile çözülebilir
- [ ] Completion FIM formatı (fill-in-the-middle) model bazlı optimize edilebilir — Gemma'nın FIM token'ları farklı
- [ ] Multi-model desteği — farklı görevler için farklı model seçimi (ör. büyük model chat, küçük model completion)
- [ ] Test coverage sıfır — vitest veya jest entegrasyonu eklenebilir
- [ ] `icon.png` (128×128) henüz yok — Marketplace yayını için `icon.svg`'den dönüştürülmeli
