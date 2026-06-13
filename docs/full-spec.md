# Gemma Agent — Tam Teknik Spesifikasyon

> **⚠ Round 2 mimari güncellemesi (2026-06):** Aşağıdaki bazı bölümler 1. tur
> yapısına (`src/ollama/client.ts`, WebviewPanel) atıf yapar. Güncel mimari:
> - **`src/llm/` katmanı** tüm LLM trafiğini taşır: `provider.ts` (LlmProvider),
>   `ollamaProvider.ts` + `openaiCompatProvider.ts` (Ollama **veya** OpenAI-uyumlu),
>   `client.ts` (facade), `backendService.ts` (tek durum kaynağı), `streamParse.ts`,
>   `contextWindow.ts`, `instructions*.ts`. `src/ollama/` kaldırıldı.
> - Chat artık **sidebar WebviewView** (`gemmaAgent.chatView`), WebviewPanel değil.
> - Storage **v2** çoklu oturum (`src/providers/sessionStore.ts`); tool kartları persist edilir.
> - Yeni modüller: `agent/toolCallParser.ts`, `agent/editApply.ts`, `index/chunker.ts`,
>   `index/workspaceIndex.ts`, `providers/previewContentProvider.ts`, saf `*Utils/*Clean` modülleri.
> - Build: esbuild → `dist/`; `tsc → out/` test/tip içindir. **Güncel ve eksiksiz yapı: `CLAUDE.md`.**

## 1. Genel Bakış

Gemma Agent, VS Code içinde yerel bir model sunucusu (Ollama veya OpenAI-uyumlu) aracılığıyla çalışan, internet bağlantısı gerektirmeyen bir AI kodlama asistanıdır. Kullanıcı verisi hiçbir zaman dış sunucuya gönderilmez.

> UI dili İngilizce'dir; model, kullanıcının yazdığı dilde yanıt verir (sistem promptu talimatı).

**Temel Özellikler:**
- Sohbet paneli (WebviewPanel tabanlı) — kalıcı geçmiş, slash komutları, `#dosya` referansları
- Inline kod tamamlama (debounce: 600ms; kelime-kelime kabul, alternatif öneriler, dil bazlı aç/kapa)
- Inline düzenleme — yanıt editöre canlı stream edilir, CodeLens ile Accept/Reject
- Sağ tık kod aksiyonları (explain / refactor / fix / test)
- Terminal entegrasyonu + SCM commit mesajı üretimi
- Ajansal dosya düzenleme (XML tool-call döngüsü) — komut onayı, undo checkpoint'leri
- Context window yönetimi (token tahmini + konuşma budaması)

---

## 2. Mimari

### 2.1 Katmanlar

```
VS Code Extension Host
│
├── extension.ts          ← Aktivasyon, komut kaydı, provider init, Ollama lifecycle
├── statusBar.ts          ← Event-driven status bar (backoff'lu yeniden bağlanma)
│
├── Providers (VS Code API ile entegrasyon)
│   ├── ChatProvider          ← WebviewPanel, kalıcı geçmiş, slash komutları, tool onayı
│   ├── CompletionProvider    ← InlineCompletionItemProvider (+ alternatifler, dil filtresi)
│   ├── InlineEditProvider    ← Streamed in-place edit + decoration + CodeLens
│   ├── CodeActionProvider    ← CodeActionProvider (lightbulb)
│   ├── TerminalProvider      ← Terminal komut çalıştırma
│   └── ScmProvider           ← Commit mesajı üretimi (built-in Git extension API)
│
├── Agent (otonom görev yürütme)
│   ├── agentLoop.ts          ← Tool-call döngüsü, onay hook'ları, self-healing parser
│   ├── tools.ts              ← 7 araç (dosya, komut, arama, diagnostics)
│   └── checkpoints.ts        ← Undo için mutasyon öncesi dosya snapshot'ları
│
├── Ollama Client
│   ├── client.ts             ← Modül-seviyesi fonksiyonlar, tipli OllamaError
│   └── contextWindow.ts      ← Token tahmini + fitMessages budaması
│
└── Webview UI
    ├── media/chat.js     ← Vanilla JS, RAF-batched streaming, popup'lar, tool kartları
    └── media/chat.css    ← VS Code tema değişkenleriyle uyumlu stil
```

### 2.2 Veri Akışı — Chat

```
Kullanıcı mesaj yazar (slash komutu ise prompt şablonuna genişletilir,
context eklenmemişse aktif seçim/dosya otomatik iliştirilir)
    → media/chat.js (vscode.postMessage {type:'sendMessage', text, contexts})
    → ChatProvider.handleUserMessage()
    → fitMessages([system, ...history], budget)   ← budget = numCtx − maxTokens − 256
    → ollamaChat({messages, signal})   ← src/ollama/client.ts (num_ctx dahil)
    → Ollama /api/chat (NDJSON streaming)
    → Her chunk: postMessage({type:'chunk', text})
    → chat.js: scheduleChunk() → requestAnimationFrame → DOM güncellenir
    → Bitti: postMessage({type:'endAssistant'}) + saveHistory() (workspaceState)
```

### 2.3 Veri Akışı — Agent Döngüsü

```
Kullanıcı agent görevi verir
    → ChatProvider.runAgent()  — Checkpoint oluşturur, hook'ları bağlar
    → agentLoop.ts: runAgentLoop(…, hooks) generator başlar
        └── Her iterasyonda:
            1. yield {type:'agentThinking', iteration, maxIterations}
            2. fitMessages() ile konuşma budanır, ollamaChat() ile yanıt toplanır
               (son ~12 karakter tutulur — kısmi <tool_call açılışı UI'a sızmaz)
            3. <tool_call>...</tool_call> aranır; yoksa ```json fenced blok denenir
            4. Hiçbiri yoksa: yield {type:'done'} → loop biter
            5. Parse hatasında: modele düzeltme mesajı push edilir, döngü devam eder
            6. Bulunursa:
               - yield {type:'tool_call', tool, callId, requiresApproval}
               - Onay gerekiyorsa: await hooks.confirmTool() — webview'de
                 Approve / Deny / Always allow butonları
               - Deny → tool çalışmaz, modele DENIED bildirimi gider
               - create_file/edit_file öncesi hooks.beforeFileMutation() → snapshot
               - executeTool(toolCall, signal) çalışır (run_command abort edilebilir)
               - yield {type:'tool_result', result, callId}
    → Koşu sonunda dosya değiştiyse: {type:'checkpointAvailable', files}
      → webview'de "↩ Undo edits (N files)" barı
```

---

## 3. Provider Detayları

### 3.1 ChatProvider (`src/providers/chatProvider.ts`)

- `vscode.window.createWebviewPanel()` ile panel açar (**`WebviewViewProvider` değil**)
- Constructor `vscode.ExtensionContext` alır
- **Kalıcı geçmiş:** `workspaceState` key `gemmaAgent.chatHistory.v1`; şema `{version:1, savedAt, messages:[{role, content, ts}]}`; cap 80 mesaj / 512 KB. Kayıt noktaları: runChat/runAgent sonu (Stop ile kesilen kısmi yanıt da saklanır), regenerate, clearHistory. Tool kartları persist edilmez
- **Slash komutları:** `SLASH_COMMANDS` tek kaynak (`/explain`, `/fix`, `/tests`, `/docs`, `/clear`); `init` mesajıyla webview'e gönderilir; context yoksa aktif seçim/dosya otomatik eklenir
- **`#dosya` referansları:** `requestFileList` (10 sn cache'li `findFiles`) → popup → `attachFile` → mevcut `contextAdded` chip akışı
- **Tool onayı:** `pendingApprovals: Map<callId, resolver>`; webview `toolApproval` mesajı resolver'ı çözer; "Always allow" → `sessionAutoApprove` (panel dispose / clear'da sıfırlanır); abort → otomatik deny
- **Undo:** koşu başına bir `Checkpoint`; `undoCheckpoint` mesajı `restore()` çağırır
- Agent modu: `this.agentMode` boolean, `runAgent()` / `runChat()` dallanması

### 3.2 CompletionProvider (`src/providers/completionProvider.ts`)

- `InlineCompletionItemProvider` implement eder
- `gemmaAgent.completionEnabled` false ise null döner
- **Dil filtresi:** `gemmaAgent.completionLanguages` map — exact languageId → `"*"` → true
- Debounce süresi: `gemmaAgent.completionDebounceMs` (default: 600ms)
- **Yarış düzeltmesi:** süpersede edilen isteğin Promise'i `pendingResolve` ile null'a çözülür
- **Alternatifler:** `gemmaAgent.completionAlternatives` (1–3); >1 ise ek üretimler `temperature: 0.8` ile sıralı yapılır, dedupe edilir; `Alt+]` / `Alt+[` ile gezilir
- Kelime-kelime kabul: VS Code'un `editor.action.inlineSuggest.acceptNextWord` komutu; `Cmd+→` keybinding contribution'ı eklendi
- Bağlam: 60 satır prefix + 20 satır suffix; token limiti `completionMaxTokens` (default: 150)

### 3.3 InlineEditProvider (`src/providers/inlineEditProvider.ts`)

- **Streamed in-place edit** (eski virtual-document diff akışı kaldırıldı):
  - Seçim varsa: seçim silinir, yanıt aynı konuma chunk chunk eklenir — hepsi **tek undo birimi** (`undoStopBefore/After: false`)
  - Seçim yoksa: cursor'a ekleme (insert mode); ~40 satır önce / ~15 satır sonra bağlam
  - Eklenen aralık `diffEditor.insertedTextBackground` decoration ile vurgulanır
  - Stream bitince CodeLens: `✓ Accept (⌘⏎)` / `✗ Reject (Esc)` — `gemmaAgent.inlineEditActive` context key'i ile dar keybinding'ler
  - Reject `originalText`'i geri yazar (undo komutu değil — kullanıcının araya yaptığı düzenlemeler korunur)
  - Stream sırasında kullanıcı aralığa yazarsa stream durur, review'a geçilir; aralık dışı sınır ihlalinde session sessizce kapanır
  - Hata/iptal ortasında orijinal otomatik geri yüklenir
- Markdown fence'leri akarken soyulur; `[CURSOR]` ekoları temizlenir

### 3.4 CodeActionProvider (`src/providers/codeActionProvider.ts`)

- `gemmaAgent.codeActionsEnabled` false ise devre dışı
- Sağ tık menüsüne 5 aksiyon ekler: explain, refactor, fix, generateTests, inlineEdit
- Her aksiyon seçili kodu `chatProvider.sendToChat()` üzerinden sohbet paneline gönderir

### 3.5 TerminalProvider (`src/providers/terminalProvider.ts`)

- `gemmaAgent.runInTerminal` komutunu karşılar
- Seçili kodu terminalde çalıştırır; terminal çıktısını açıklar/düzeltir (manuel yapıştırma)

### 3.6 ScmProvider (`src/providers/scmProvider.ts`)

- `gemmaAgent.generateCommitMessage` komutu + SCM başlık çubuğunda ✨ butonu (`scm/title`, `scmProvider == git`)
- Built-in Git extension API (`vscode.git` → `getAPI(1)`); `repo.diff(true)` staged, boşsa working-tree (CLI fallback'li)
- Diff ~6000 token'a kırpılır; yanıt `repo.inputBox.value`'ya stream edilir
- Prompt: conventional commit, subject ≤ 72 karakter, imperative

---

## 4. Agent Sistemi

### 4.1 agentLoop.ts

ReAct benzeri döngü. LLM'den **XML wrapper içinde JSON** formatında tool çağrısı bekler:

```
<tool_call>
{"tool":"read_file","path":"src/extension.ts"}
</tool_call>
```

Fallback olarak ```json fenced blok içindeki `{"tool": …}` da kabul edilir.
Tool çağrısı yoksa (düz metin yanıt) döngü biter (`{type:'done'}`).

Parser 3-geçişli: standart `JSON.parse` → literal newline repair → regex fallback
(pass 3'te tool adı `TOOL_NAMES` union'ına karşı doğrulanır).
**Parse hatası döngüyü bitirmez** — modele düzeltme talimatı push edilir (1 iterasyon harcar).

Her iterasyonda `fitMessages()` ile konuşma `numCtx` bütçesine budanır.
Streaming sırasında son ~12 karakter tutulur (kısmi `<tool_call` sızıntısı önlenir).

`agentMaxIterations` (default: 10, max: 30) aşılırsa döngü durur.

**Onay (hooks):** `AgentHooks.confirmTool(call, callId)` — `gemmaAgent.agentRequireApproval`
(`commands` default / `commandsAndWrites` / `never`) hangi tool'ların onay gerektirdiğini belirler.
`AgentHooks.beforeFileMutation(path)` — create/edit öncesi checkpoint snapshot'ı.

**Emitted events:**

| Event | Ne zaman |
|---|---|
| `agentThinking` | Her iterasyon başında (iteration, maxIterations içerir) |
| `tool_call` | Parse sonrası (tool, callId, requiresApproval içerir) |
| `tool_result` | Execute (veya deny) sonrası (ok, output, callId içerir) |
| `text` | LLM'in tool olmayan metin çıktısı |
| `warning` | Non-fatal sorun (ör. parse retry) — UI'da notice |
| `done` | Döngü başarıyla bitti |
| `error` | Ölümcül hata |

### 4.2 tools.ts — Araçlar

| Araç | JSON key'ler | Açıklama |
|---|---|---|
| `read_file` | `path` | Dosya okur (max 500 KB, max 300 satır önizleme) |
| `create_file` | `path`, `content` | Dosya oluşturur veya üzerine yazar |
| `edit_file` | `path`, `search`, `replace` | Tam metin eşleşmesiyle değiştirir (CRLF normalize) |
| `run_command` | `command` | Shell komutu, stdout+stderr (max 4 KB); 30 sn açık timeout, abort'ta SIGTERM→SIGKILL |
| `list_files` | `path` | Dizin içeriğini listeler |
| `search_files` | `query`, `path?`, `regex?` | Satır bazlı arama, doğru satır numaraları (max 200 dosya, 100 eşleşme); `regex:true` ile regex |
| `get_diagnostics` | `path?` | Compiler/linter Error+Warning'leri (max 50); path verilmezse tüm workspace |

**Güvenlik:** `resolveUri()` workspace dışına çıkan path'leri reddeder.
`run_command` ve (ayara göre) dosya yazma araçları kullanıcı onayı gerektirir.

### 4.3 checkpoints.ts — Undo

- Koşu başına bir `Checkpoint`; dosya başına **ilk yazım öncesi** snapshot (first-write-wins)
- >1 MB dosyalar atlanır ve restore'da "too large" olarak raporlanır
- `restore()`: snapshot'ı geri yazar, agent'ın yarattığı dosyaları siler
- Sadece son koşunun checkpoint'i bellekte tutulur; restart'a persist edilmez

---

## 5. Ollama Client (`src/ollama/client.ts`)

Modül-seviyesi export fonksiyonları — sınıf instance'ı **değil**.

```typescript
// Sohbet (geçmişle, streaming AsyncGenerator)
ollamaChat({ messages, signal }): AsyncGenerator<string>

// Tek seferlik üretim (completion, commit mesajı)
ollamaGenerate({ prompt, system, maxTokens, temperature?, signal }): Promise<string>

// Model yönetimi
listModels(): Promise<string[]>
isOllamaRunning(): Promise<boolean>
unloadModel(model: string): Promise<void>      // keep_alive: 0
warmupModel(model: string, signal): Promise<void>  // hata fırlatır (sahte Ready yok)

// Hatalar
class OllamaError { kind: 'connection' | 'model-not-found' | 'http' | 'timeout' }
describeOllamaError(err): string   // kullanıcıya gösterilecek mesaj
DEFAULT_MODEL = 'gemma4:e4b'
```

Tüm isteklere `options.num_ctx` (`gemmaAgent.numCtx`) eklenir.

### contextWindow.ts

```typescript
estimateTokens(s)          // ~4 karakter/token
computeBudget(numCtx, maxTokens)  // numCtx − maxTokens − 256
fitMessages(messages, budget)     // sistem + son mesaj sabit;
                                  // önce tool-exchange çiftleri, sonra en eski mesajlar atılır;
                                  // tek dev mesajda ortadan kırpma
```

---

## 6. Webview UI

### Mesajlaşma Protokolü (extension ↔ webview)

**Webview → Extension:**

| type | payload | Açıklama |
|---|---|---|
| `sendMessage` | `text`, `contexts?` | Kullanıcı mesajı gönderir |
| `clearHistory` | — | Geçmişi (storage dahil) siler |
| `stopGeneration` | — | Aktif isteği iptal eder |
| `insertCode` | `code` | Kodu aktif editöre yapıştırır |
| `changeModel` | `model` | Model değiştirir |
| `toggleFeature` | `feature` | completion / codeActions toggle |
| `requestContext` | `source` | file / selection bağlamı ister |
| `toggleAgentMode` | — | Agent modunu açar/kapatır |
| `refreshModels` | — | Yüklü modelleri yeniler |
| `startOllama` / `stopOllama` | — | Ollama lifecycle |
| `pullModel` | `model` | ollama pull başlatır |
| `regenerate` | `text` | Son yanıtı yeniden üretir |
| `toolApproval` | `callId`, `decision` | approve / deny / always |
| `undoCheckpoint` | `checkpointId` | Agent düzenlemelerini geri alır |
| `requestFileList` | `query` | `#dosya` popup'ı için dosya listesi |
| `attachFile` | `path` | Dosyayı context chip olarak ekler |

**Extension → Webview:**

| type | payload | Açıklama |
|---|---|---|
| `init` | `installedModels`, `availableModels`, `currentModel`, `features`, `ollamaRunning`, `agentMode`, `slashCommands` | İlk yükleme |
| `settingsUpdate` | `currentModel`, `features` | Ayar değiştiğinde |
| `modelLoading` / `modelReady` | `model` | Warm-up durumu |
| `modelWarmupFailed` | `model`, `message` | Warm-up hatası (badge resetlenir + hata gösterilir) |
| `agentMode` | `enabled` | Agent modu değişti |
| `userMessage` | `text` | Kullanıcı mesajı |
| `startAssistant` / `chunk` / `endAssistant` | — / `text` / — | Streaming yaşam döngüsü |
| `toolCall` | `tool`, `callId`, `requiresApproval` | Tool kartı (onay butonlu olabilir) |
| `toolApprovalResolved` | `callId`, `approved` | Onay kararı karta yansıtılır |
| `toolResult` | `result`, `callId` | Tool tamamlandı |
| `agentThinking` | `iteration`, `maxIterations` | Agent düşünüyor göstergesi |
| `notice` | `text` | Non-fatal bildirim (ince satır) |
| `contextTrimmed` | `count` | Konuşma budandı bildirimi |
| `checkpointAvailable` | `checkpointId`, `files` | "Undo edits" barı |
| `checkpointRestored` | `restored`, `failed` | Geri alma sonucu |
| `error` | `text` | Hata mesajı |
| `history` | `messages` | Panel açıldığında geçmiş |
| `contextAdded` | `name`, `content`, `lang` | Context chip eklendi |
| `contextError` | `message` | Context isteği başarısız |
| `fileList` | `files` | `#dosya` popup içeriği |

### Rendering

- **Streaming**: RAF (`requestAnimationFrame`) batching
- **Syntax highlighting**: Vanilla JS tokenizer (Python, JS/TS, C/C++, Go, Rust, Java, C#, Bash)
- **Popup'lar**: `#cmdPopover` — slash komutları ve `#dosya` için ortak makine (ok tuşları, Enter/Tab, Escape)
- **Tool kartları**: `data-call-id` ile anahtarlı; awaiting/running/success/failure durumları

---

## 7. Konfigürasyon Referansı (Tam Liste)

| Anahtar | Tip | Default | Açıklama |
|---|---|---|---|
| `gemmaAgent.ollamaUrl` | string | `http://localhost:11434` | Ollama sunucu adresi |
| `gemmaAgent.model` | enum | `gemma4:e4b` | Kullanılan model |
| `gemmaAgent.completionEnabled` | boolean | `true` | Inline completion aktif/pasif |
| `gemmaAgent.completionDebounceMs` | number | `600` | Completion tetikleme gecikmesi (ms) |
| `gemmaAgent.completionMaxTokens` | number | `150` | Completion max token (32–512) |
| `gemmaAgent.completionLanguages` | object | `{"*":true, markdown:false, plaintext:false, scminput:false}` | Dil bazlı completion |
| `gemmaAgent.completionAlternatives` | number | `1` | Alternatif öneri sayısı (1–3) |
| `gemmaAgent.maxTokens` | number | `4096` | Chat max token (num_predict) |
| `gemmaAgent.numCtx` | number | `8192` | Ollama context window (num_ctx) |
| `gemmaAgent.codeActionsEnabled` | boolean | `true` | Lightbulb menüsü aktif/pasif |
| `gemmaAgent.ollamaOnExit` | enum | `keep` | Çıkışta Ollama davranışı (ask/keep/stop) |
| `gemmaAgent.agentMaxIterations` | number | `10` | Agent max iterasyon (1–30) |
| `gemmaAgent.agentRequireApproval` | enum | `commands` | Onay kapsamı (commands / commandsAndWrites / never) |

---

## 8. Geliştirme Notları

### Yeni Komut Ekleme

1. `package.json` → `contributes.commands` dizisine ekle
2. `package.json` → `contributes.menus` veya `keybindings`'e ekle
3. `src/extension.ts`'te `vscode.commands.registerCommand` ile kaydet
4. İlgili provider'a logic ekle veya yeni provider oluştur

### Yeni Agent Tool Ekleme

1. `src/agent/tools.ts`'te `TOOL_NAMES` dizisine yeni isim ekle
2. Araç fonksiyonunu yaz
3. `executeTool()` switch'ine case ekle
4. `AGENT_SYSTEM_PROMPT` içindeki araç listesini güncelle
5. `media/chat.js` → `TOOL_META`'ya emoji/label ekle

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

- [ ] Tool kartları geçmişe persist edilmez (sadece metin restore edilir)
- [ ] Undo checkpoint'i yalnızca son agent koşusu için ve restart'a persist edilmez
- [ ] Completion FIM formatı model bazlı optimize edilebilir — Gemma'nın FIM token'ları farklı
- [ ] Multi-model desteği — farklı görevler için farklı model seçimi
- [ ] Test coverage sıfır — vitest veya jest entegrasyonu eklenebilir
- [ ] `icon.png` (128×128) henüz yok — Marketplace yayını için `icon.svg`'den dönüştürülmeli
- [ ] `@workspace` semantik arama ve workspace indeksleme yok (küçük projelerde `search_files` yeterli)
