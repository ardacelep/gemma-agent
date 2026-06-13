# Gemma Agent — Claude Kılavuzu

## Proje Özeti
VS Code extension: Ollama üzerinden yerel Gemma modelleriyle çalışan, tamamen offline AI coding assistant.
**Publisher:** ardacelep | **Versiyon:** 0.1.0 | **Lisans:** MIT

## Teknoloji Yığını
- **Dil:** TypeScript (strict). Tip kontrolü/test için `tsc → out/`; runtime için **esbuild → `dist/extension.js`** (bundle).
- **Platform:** VS Code Extension API (^1.93.0)
- **LLM Backend:** Protokol-agnostik. **Ollama** (native API) veya herhangi bir **OpenAI-uyumlu** sunucu (LM Studio :1234, Jan :1337, llama.cpp llama-server :8080, vLLM, LocalAI). `gemmaAgent.apiProtocol` ile seçilir.
- **Model:** Gemma serisi (default: `gemma4:e4b` — kodda `DEFAULT_MODEL` sabiti)
- **Build:** `npm run bundle` (esbuild) · `npm run compile` (tsc, tip/test) · `npm test` (node:test)
- **UI:** Sidebar (activity bar) WebviewView. UI dili İngilizce (model kullanıcının dilinde yanıt verir).

## Klasör Yapısı
```
src/
├── extension.ts          # Giriş noktası, komut/provider kaydı (minimal tut)
├── statusBar.ts          # BackendService'e abone saf renderer (spinner, flash hint)
├── llm/                  # TÜM LLM trafiği bu katmandan geçer
│   ├── provider.ts           # LlmProvider arayüzü + capabilities
│   ├── ollamaProvider.ts     # Ollama (NDJSON, /api/chat|generate|embed|pull)
│   ├── openaiCompatProvider.ts # OpenAI-uyumlu (/v1/chat|models|embeddings, SSE)
│   ├── client.ts             # Facade (ollamaChat/Generate/Embed, getCapabilities, pullModelStream)
│   ├── backendService.ts     # Tek durum kaynağı (serverState/models/pulls, EventEmitter, backoff)
│   ├── streamParse.ts        # Saf NDJSON+SSE parser'ları (testli)
│   ├── contextWindow.ts      # Token tahmini + fitMessages budaması (testli)
│   ├── instructions.ts       # .gemma/rules.md watcher + getInstructionSuffix
│   └── instructionsCore.ts   # Saf combineInstructions (testli)
├── providers/
│   ├── chatProvider.ts       # WebviewViewProvider: oturumlar, slash/#/@ , onay, review barı
│   ├── completionProvider.ts # Inline tamamlama (+ alternatifler, dil filtresi, spinner)
│   ├── completionClean.ts    # Saf clean/isCommentLine (testli)
│   ├── inlineEditProvider.ts # Streamed in-place edit + CodeLens; runInlineEdit (quick-fix paylaşır)
│   ├── codeActionProvider.ts # Lightbulb + "✨ Fix with Gemma" diagnostic quick-fix
│   ├── terminalProvider.ts   # Shell integration yakalama (ring buffer) + #terminal
│   ├── scmProvider.ts        # Commit mesajı üretimi (Git extension API)
│   ├── scmUtils.ts           # Saf capDiff/cleanupCommitMessage (testli)
│   ├── sessionStore.ts       # Saf oturum modeli + v1→v2 migration (testli)
│   └── previewContentProvider.ts # gemma-preview virtual docs (diff önizleme)
├── agent/
│   ├── agentLoop.ts      # Tool-call döngüsü, onay hook'ları, auto-verify
│   ├── tools.ts          # Agent araçları (dosya/komut/arama/diagnostics)
│   ├── toolCallParser.ts # Saf parser (TOOL_NAMES/parseToolCall — testli)
│   ├── editApply.ts      # Saf edit_file replace (tools + diff preview paylaşır, testli)
│   └── checkpoints.ts    # Undo/review için dosya snapshot'ları
├── index/
│   ├── chunker.ts        # Saf chunk/cosine/topK/vector codec (testli)
│   └── workspaceIndex.ts # @workspace embedding indeksi (storageUri JSON)
└── webview/utils.ts
media/
├── chat.css / chat.js    # Webview UI (vanilla JS)
├── walkthrough/*.md      # Onboarding adımları
├── icon.svg / icon.png   # icon.png marketplace içindir
tests/*.test.mjs          # node:test, derlenmiş out/ saf modüllerine karşı
```

## Temel Kurallar
- Her yeni özellik için ilgili `provider`/`agent`/`llm` dosyasına ekle, `extension.ts`'i minimal tut
- **Tüm LLM trafiği `src/llm/` katmanından** (client facade → provider). Başka yerde `fetch` ile model çağırma
- Saf mantığı (parser, token, chunk, migration) vscode'suz modüllere ayır ki `node:test` ile test edilebilsin
- Webview tarafı vanilla JS (`media/chat.js`), React/framework ekleme
- Tüm kullanıcı ayarları `gemmaAgent.*` prefix'iyle `package.json` configuration'ına eklenecek
- Agent max iterations config'den okunur (`agentMaxIterations`), hardcode etme
- Sıfır runtime dependency (esbuild devDep; codicon/walkthrough/font asset serbest)

## Konfigürasyon Anahtarları (Sık Kullanılanlar)
| Anahtar | Default | Açıklama |
|---|---|---|
| `gemmaAgent.apiProtocol` | `ollama` | `ollama` veya `openai-compatible` |
| `gemmaAgent.ollamaUrl` | `http://localhost:11434` | Sunucu adresi (Ollama veya OpenAI-uyumlu) |
| `gemmaAgent.model` | `gemma4:e4b` | Aktif model |
| `gemmaAgent.completionModel` | `""` | Completion için ayrı model (boş = ana model) |
| `gemmaAgent.maxTokens` | `4096` | Chat max token (num_predict) |
| `gemmaAgent.numCtx` | `8192` | Context window (num_ctx) |
| `gemmaAgent.completionLanguages` | `{"*":true,…}` | Dil bazlı completion aç/kapa |
| `gemmaAgent.completionAlternatives` | `1` | Alternatif öneri sayısı (1–3) |
| `gemmaAgent.customInstructions` | `""` | Sistem promptlarına eklenir (+ `.gemma/rules.md`) |
| `gemmaAgent.agentMaxIterations` | `10` | Agent döngü limiti |
| `gemmaAgent.agentRequireApproval` | `commands` | Tool onayı kapsamı (commands/commandsAndWrites/never) |
| `gemmaAgent.agentAutoVerify` | `true` | Düzenleme sonrası otomatik diagnostics + düzeltme |
| `gemmaAgent.embeddingModel` | `nomic-embed-text` | @workspace embedding modeli |
| `gemmaAgent.workspaceIndexEnabled` | `false` | @workspace semantik arama (opt-in) |

## Komutlar (Hızlı Referans)
`gemmaAgent.openChat` · `explainCode` · `refactorCode` · `fixCode` · `generateTests`
`inlineEdit` (+ `inlineEditAccept`/`inlineEditReject`/`fixDiagnostic`) · `runInTerminal` · `toggleCompletion`
`startOllama` · `stopOllama` · `installServer` · `pullModel` · `generateCommitMessage` · `buildIndex`

## Test
`npm test` → `tsc` derler + `node --test tests/*.test.mjs`. Saf modüller (`*Core`, `toolCallParser`,
`streamParse`, `contextWindow`, `chunker`, `editApply`, `sessionStore`, `completionClean`, `scmUtils`)
vscode import etmez; her test bunu da doğrular.

## Detaylı Dokümantasyon
Mimari detaylar, veri akışları ve genişletme rehberi için → `docs/full-spec.md`

## Token Tasarrufu
Şu tür işleri gemini-helper subagent'a devret:
- Büyük dosya okuma / arama
- Log analizi  
- Fonksiyon/class listeleme
- "Şu dosyada X var mı?" soruları
- Özet çıkarma