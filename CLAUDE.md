# Gemma Agent — Claude Kılavuzu

## Proje Özeti
VS Code extension: Ollama üzerinden yerel Gemma modelleriyle çalışan, tamamen offline AI coding assistant.
**Publisher:** ardacelep | **Versiyon:** 0.1.0 | **Lisans:** MIT

## Teknoloji Yığını
- **Dil:** TypeScript (strict), derleme hedefi `out/`
- **Platform:** VS Code Extension API (^1.85.0)
- **LLM Backend:** Ollama REST API (default: `http://localhost:11434`)
- **Model:** Gemma3/Gemma4 serisi (default: `gemma4:e4b`)
- **Build:** `tsc -p ./` → `npm run compile`

## Klasör Yapısı
```
src/
├── extension.ts          # Giriş noktası, komutları kaydeder
├── providers/
│   ├── chatProvider.ts       # Webview chat paneli
│   ├── completionProvider.ts # Inline kod tamamlama
│   ├── inlineEditProvider.ts # Seçili kodu inline düzenleme
│   ├── codeActionProvider.ts # Lightbulb (sağ tık) aksiyonları
│   └── terminalProvider.ts   # Terminal entegrasyonu
├── agent/
│   ├── agentLoop.ts      # Tool-call döngüsü (agentMaxIterations config'den okunur)
│   └── tools.ts          # Agent araçları (dosya okuma/yazma/komut çalıştırma)
├── ollama/
│   └── client.ts         # Ollama REST istemcisi
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
| `gemmaAgent.maxTokens` | `4096` | Chat max token |
| `gemmaAgent.completionMaxTokens` | `150` | Completion max token |
| `gemmaAgent.agentMaxIterations` | `10` | Agent döngü limiti |

## Komutlar (Hızlı Referans)
`gemmaAgent.openChat` · `explainCode` · `refactorCode` · `fixCode` · `generateTests`
`inlineEdit` · `runInTerminal` · `toggleCompletion` · `startOllama` · `pullModel`

## Detaylı Dokümantasyon
Mimari detaylar, veri akışları ve genişletme rehberi için → `docs/full-spec.md`
