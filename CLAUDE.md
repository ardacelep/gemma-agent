# Gemma Agent — Claude Kılavuzu

## Proje Özeti
VS Code extension: Ollama üzerinden yerel Gemma modelleriyle çalışan, tamamen offline AI coding assistant.
**Publisher:** ardacelep | **Versiyon:** 0.1.0 | **Lisans:** MIT

## Teknoloji Yığını
- **Dil:** TypeScript (strict), derleme hedefi `out/`
- **Platform:** VS Code Extension API (^1.85.0)
- **LLM Backend:** Ollama REST API (default: `http://localhost:11434`)
- **Model:** Gemma3/Gemma4 serisi (default: `gemma4:e4b` — kodda `DEFAULT_MODEL` sabiti)
- **Build:** `tsc -p ./` → `npm run compile`
- **UI dili:** İngilizce (model, kullanıcının yazdığı dilde yanıt verir)

## Klasör Yapısı
```
src/
├── extension.ts          # Giriş noktası, komutları kaydeder (minimal tut)
├── statusBar.ts          # Event-driven status bar (backoff'lu)
├── providers/
│   ├── chatProvider.ts       # Webview chat paneli, kalıcı geçmiş, slash komutları, tool onayı
│   ├── completionProvider.ts # Inline kod tamamlama (+ alternatifler, dil filtresi)
│   ├── inlineEditProvider.ts # Streamed in-place edit + CodeLens Accept/Reject
│   ├── codeActionProvider.ts # Lightbulb (sağ tık) aksiyonları
│   ├── terminalProvider.ts   # Terminal entegrasyonu
│   └── scmProvider.ts        # Commit mesajı üretimi (Git extension API)
├── agent/
│   ├── agentLoop.ts      # Tool-call döngüsü, onay hook'ları (agentMaxIterations config'den)
│   ├── tools.ts          # 7 agent aracı (dosya/komut/arama/diagnostics)
│   └── checkpoints.ts    # Undo için mutasyon öncesi dosya snapshot'ları
├── ollama/
│   ├── client.ts         # Ollama REST istemcisi (OllamaError, DEFAULT_MODEL)
│   └── contextWindow.ts  # Token tahmini + fitMessages budaması
└── webview/
    └── utils.ts          # Webview yardımcı fonksiyonları
media/
├── chat.css / chat.js    # Webview UI (vanilla JS)
└── icon.svg
```

## Temel Kurallar
- Her yeni özellik için ilgili `provider` veya `agent` dosyasına ekle, `extension.ts`'i minimal tut
- Ollama client'ı `src/ollama/client.ts` üzerinden kullan, direkt fetch yazma
- Webview tarafı vanilla JS (`media/chat.js`), React/framework ekleme
- Tüm kullanıcı ayarları `gemmaAgent.*` prefix'iyle `package.json` configuration'ına eklenecek
- Agent max iterations config'den okunur (`agentMaxIterations`), hardcode etme

## Konfigürasyon Anahtarları (Sık Kullanılanlar)
| Anahtar | Default | Açıklama |
|---|---|---|
| `gemmaAgent.ollamaUrl` | `http://localhost:11434` | Ollama adresi |
| `gemmaAgent.model` | `gemma4:e4b` | Aktif model |
| `gemmaAgent.maxTokens` | `4096` | Chat max token (num_predict) |
| `gemmaAgent.numCtx` | `8192` | Ollama context window (num_ctx) |
| `gemmaAgent.completionMaxTokens` | `150` | Completion max token |
| `gemmaAgent.completionLanguages` | `{"*":true,…}` | Dil bazlı completion aç/kapa |
| `gemmaAgent.completionAlternatives` | `1` | Alternatif öneri sayısı (1–3) |
| `gemmaAgent.agentMaxIterations` | `10` | Agent döngü limiti |
| `gemmaAgent.agentRequireApproval` | `commands` | Tool onayı kapsamı |

## Komutlar (Hızlı Referans)
`gemmaAgent.openChat` · `explainCode` · `refactorCode` · `fixCode` · `generateTests`
`inlineEdit` (+ `inlineEditAccept`/`inlineEditReject`) · `runInTerminal` · `toggleCompletion`
`startOllama` · `stopOllama` · `pullModel` · `generateCommitMessage`

## Detaylı Dokümantasyon
Mimari detaylar, veri akışları ve genişletme rehberi için → `docs/full-spec.md`

## Token Tasarrufu
Şu tür işleri gemini-helper subagent'a devret:
- Büyük dosya okuma / arama
- Log analizi  
- Fonksiyon/class listeleme
- "Şu dosyada X var mı?" soruları
- Özet çıkarma