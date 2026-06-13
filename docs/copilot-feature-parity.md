# Copilot Feature Parity — Yol Haritası

GitHub Copilot'ı kaliteli yapan özelliklerin araştırılmasıyla oluşturulmuş, Gemma Agent için önceliklendirilmiş uygulama listesi.

> **Son güncelleme (2026-06):** Tüm P1 maddeleri + seçili P2'ler uygulandı (aşağıda ✅ işaretli).
> UI dili İngilizce'ye taşındı; model, kullanıcının yazdığı dilde yanıt verir.

**Lejant:**
- ✅ = Mevcut uzantıda var
- 🔴 P1 = Kritik eksik — kullanıcı deneyimini doğrudan kötüleştiriyor
- 🟠 P2 = Önemli eksik — Copilot'a yaklaşmak için gerekli
- 🟡 P3 = Kalite artışı — "polished" his için
- ⚪ P4 = Gelişmiş / uzun vadeli

---

## 1. Inline Completion (Ghost Text)

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 1.1 | Ghost text gösterimi | ✅ | Cursor'da silikleşmiş metin olarak gösterilir |
| 1.2 | Tab ile tam kabul | ✅ | Tek tuşla tüm öneriyi kabul et |
| 1.3 | Escape ile reddet | ✅ | |
| 1.4 | Debounce (600ms) | ✅ | Çok erken tetiklenmeyi önler |
| 1.5 | FIM prompt (prefix + suffix) | ✅ | 60 satır prefix + 20 satır suffix |
| 1.6 | Kelime kelime kabul | ✅ | `Cmd+→` keybinding contribution eklendi; VS Code'un `inlineSuggest.acceptNextWord` komutu her provider'la çalışır |
| 1.7 | Alternatif öneriler arası geçiş | ✅ | `gemmaAgent.completionAlternatives` (1–3, default 1, opt-in); `Alt+]` / `Alt+[` ile gezin. VS Code listeyi peşin istediği için her alternatif ek bir üretim = ek gecikme |
| 1.8 | Dil bazlı enable/disable | ✅ | `gemmaAgent.completionLanguages` object map (`"*"` wildcard destekli); default'ta markdown/plaintext kapalı |
| 1.9 | **Completion'da açık sekmeleri bağlam olarak kullan** | 🟠 P2 | Sadece aktif dosyayı değil, editörde açık diğer dosyaları da prefix olarak ekle |
| 1.10 | **Minimum token eşiği** | 🟡 P3 | Çok kısa (`<3 karakter`) veya sadece boşluk olan satırlarda tetiklenmemeli — kısmen var |
| 1.11 | **`///` / `/**` yorumda docstring üretimi** | 🟡 P3 | Yorum satırı açılınca otomatik fonksiyon dokümantasyonu üret |

---

## 2. Inline Chat (Editör İçi Chat)

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 2.1 | Seçili kod üzerinde inline düzenleme | ✅ | `Cmd+Shift+I`, instruction gir, in-place stream |
| 2.2 | Önizleme | ✅ | Streamed insertion + decoration highlight (eski modal diff akışı kaldırıldı) |
| 2.3 | Tek undo birimi | ✅ | Tüm stream tek `Cmd+Z` ile geri alınır |
| 2.4 | Inline chat widget | ✅ | Continue.dev tarzı: yanıt seçimin yerine canlı stream edilir, `✓ Accept (⌘⏎)` / `✗ Reject (Esc)` CodeLens'leri çıkar. (Copilot'un floating widget'ı private API — extension'lara kapalı) |
| 2.5 | Stream edilen düzenleme | ✅ | Chunk'lar editöre canlı yazılır, değişen aralık decoration ile vurgulanır |
| 2.6 | Seçimsiz inline chat | ✅ | Seçim olmadan `Cmd+Shift+I` → cursor'a ekleme (insert mode, çevre kod bağlam olarak verilir) |
| 2.7 | **Slash commands inline'da** | 🟡 P3 | `/fix`, `/explain`, `/tests` komutlarını inline chat'te de destekle |

---

## 3. Chat Paneli

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 3.1 | Streaming chat | ✅ | RAF-batched |
| 3.2 | Syntax highlighting | ✅ | 10+ dil |
| 3.3 | Geçmiş (panel boyunca) | ✅ | Panel kapanınca kaybolmaz |
| 3.4 | Dosya / seçim context ekleme | ✅ | Chip'ler ile |
| 3.5 | Kod bloğu kopyala / editöre ekle | ✅ | |
| 3.6 | Regenerate son yanıt | ✅ | ↺ butonu (mükerrer user mesajı bug'ı da düzeltildi) |
| 3.7 | Geçmişi session'lar arası koru | ✅ | `workspaceState` (`gemmaAgent.chatHistory.v1`), 80 mesaj / 512 KB cap, versiyonlu şema. Tool kartları persist edilmez (sadece metin) |
| 3.8 | Slash komutları | ✅ | `/explain`, `/fix`, `/tests`, `/docs`, `/clear` — `/` yazınca autocomplete popup (ok tuşları + Enter/Tab); context eklenmemişse aktif seçim/dosya otomatik iliştirilir |
| 3.9 | `#dosya` referansları | ✅ | `#` yazınca dosya popup'ı (debounced arama, 10 sn cache); seçim chip olarak eklenir. `#sembol` henüz yok (P3) |
| 3.10 | **`@workspace` katılımcısı** | 🟠 P2 | Tüm workspace'i semantik olarak arar; `@workspace neden bu fonksiyon yavaş?` sorulabilir |
| 3.11 | **`@terminal` katılımcısı** | 🟠 P2 | Son terminal çıktısını bağlam olarak alır; hata mesajlarını açıklar |
| 3.12 | **Quick Chat** (floating, non-blocking) | 🟡 P3 | Yan panel açmadan hızlı soru sor |
| 3.13 | **Birden fazla chat oturumu** | 🟡 P3 | Oturumları adlandır, listele, switch et |
| 3.14 | **Görsel / ekran görüntüsü ekleme** | ⚪ P4 | Multimodal model varsa screenshot'ı bağlam olarak ekle |

---

## 4. Agent Modu

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 4.1 | Tool-call döngüsü (create/edit/read/run) | ✅ | XML wrapper format + fenced JSON fallback; parse hatasında döngü ölmek yerine modelden düzeltme ister (self-healing) |
| 4.2 | Canlı adım göstergesi (agentThinking) | ✅ | Spinner + "step 2/10" |
| 4.3 | Tool kart UI (çalışıyor/başarı/hata) | ✅ | Çıktı göster/gizle; kartlar `callId` ile anahtarlı |
| 4.4 | run_command stdout/stderr yakalama | ✅ | |
| 4.5 | Path traversal güvenliği | ✅ | Workspace dışına çıkamaz |
| 4.6 | Configurable maxIterations | ✅ | |
| 4.7 | "Undo Last Edit" butonu | ✅ | Her agent koşusu öncesi dosya snapshot'ları (`src/agent/checkpoints.ts`); "↩ Undo edits (N files)" barı tüm değişiklikleri geri alır, yaratılan dosyaları siler. Sadece son koşu, restart'a persist edilmez |
| 4.8 | Terminal komutlarında onay adımı | ✅ | Tool kartında Approve / Deny / Always allow; `gemmaAgent.agentRequireApproval` (`commands` default, `commandsAndWrites`, `never`). Deny modele iletilir, model uyum sağlar |
| 4.9 | **Compile/lint hataları otomatik düzelt** | 🟠 P2 | Altyapı hazır: `get_diagnostics` tool'u eklendi ve sistem promptu düzenleme sonrası diagnostics kontrolünü istiyor; tam otomatik build-döngüsü henüz yok |
| 4.10 | **Multi-dosya diff özeti** | 🟠 P2 | Kısmen: undo barı değişen dosyaları listeler; satır sayıları yok |
| 4.11 | **Agent task geçmişi** | 🟡 P3 | Tamamlanan görevleri listele, tekrar çalıştır |
| 4.12 | **Paralel agent oturumları** | ⚪ P4 | Birden fazla agent task'ı aynı anda çalıştır |

---

## 5. Next Edit Suggestions (NES) — Tahminsel Düzenleme

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 5.1 | **Gutter indikatörü ile sonraki düzenleme konumu** | 🟠 P2 | Değiştirilmesi gereken yerin satır numarasında ok/badge göster; `Tab` ile o yere atla |
| 5.2 | **Cascade düzenleme önerisi** | 🟠 P2 | Bir değişken veya fonksiyon adı değişince tüm kullanım yerlerini güncellemeyi öner |
| 5.3 | **Tipografi / mantık hatası tespiti** | 🟡 P3 | `\|\|` yerine `&&` veya ters ternary gibi yaygın hataları öner |

---

## 6. Bağlam Yönetimi (Context)

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 6.1 | Aktif dosya bağlamı | ✅ | Completion ve inline edit için |
| 6.2 | Seçim ve dosya chip'leri | ✅ | Chat için (`#dosya` referanslarıyla da eklenebilir) |
| 6.3 | **Workspace indeksleme** | 🟠 P2 | Tüm dosyaları vektörsel olarak indeksle; `@workspace` sorularında semantik arama yap |
| 6.4 | **`package.json`, `tsconfig.json` otomatik bağlamı** | 🟡 P3 | Config dosyalarını her istek için sessizce ekle |
| 6.5 | **Son terminal çıktısını otomatik yakala** | 🟡 P3 | Agent veya chat başlamadan önce aktif terminal'ın son N satırını bağlama ekle |
| 6.6 | **Git diff bağlamı** | 🟡 P3 | `git diff HEAD` çıktısını `@changes` ile chat'e ekle |

---

## 7. Hata Ayıklama ve Terminal Entegrasyonu

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 7.1 | Terminal'de komut çalıştırma (agent) | ✅ | run_command ile |
| 7.2 | runInTerminal komutu | ✅ | Seçili kodu terminale gönder |
| 7.3 | **Terminal'de inline chat** | 🟠 P2 | Terminal içinde `Cmd+I` → "bu hatayı açıkla / düzelt" |
| 7.4 | **Hata mesajlarını otomatik tanı** | 🟠 P2 | Terminal'de kırmızı çıktı göründüğünde bildirim + "düzelt" butonu |
| 7.5 | **Shell komut önerisi** | 🟡 P3 | "nasıl X yaparım" sorusuna direkt terminal komutu üret |

---

## 8. Kod İnceleme ve Kalite

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 8.1 | Kodu açıkla (explain) | ✅ | Sağ tık → context menu |
| 8.2 | Refactor | ✅ | |
| 8.3 | Fix | ✅ | |
| 8.4 | Test üret | ✅ | |
| 8.5 | Commit mesajı üret | ✅ | SCM başlık çubuğunda ✨ butonu; staged diff (boşsa working-tree) → conventional-commit mesajı SCM input box'a stream edilir |
| 8.6 | **PR özeti üret** | 🟡 P3 | `git log` ve `git diff` bazlı PR açıklaması yaz |
| 8.7 | **Güvenlik açığı tespiti** | 🟡 P3 | SQL injection, XSS, hardcoded secret gibi yaygın açıkları işaretle |
| 8.8 | **Kod karmaşıklığı / kalite önerisi** | ⚪ P4 | Statik analiz ipuçları |

---

## 9. UI / UX Kalitesi

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 9.1 | Status bar entegrasyonu | ✅ | Model adı + bağlantı durumu (artık event-driven, bkz. B6) |
| 9.2 | RAF-batched streaming | ✅ | Jank yok |
| 9.3 | Scroll-to-bottom butonu | ✅ | |
| 9.4 | Escape ile popover/üretim durdur | ✅ | |
| 9.5 | Üretim sırasında clear guard | ✅ | |
| 9.6 | Regenerate butonu | ✅ | |
| 9.7 | **Typing indicator'ı modele özel göster** | 🟡 P3 | Model adı eklenebilir |
| 9.8 | **Completion tetiklenme göstergesi** | 🟡 P3 | Status bar'da "Gemma: üretiyor…" spinner |
| 9.9 | Hata durumunda akıllı mesaj | ✅ | Tipli `OllamaError` (`connection` / `model-not-found` / `http` / `timeout`); her durum için ayrı, eyleme dönük mesaj. Warmup hatası artık sahte "Ready" göstermiyor |
| 9.10 | **Renk teması uyumu (high contrast)** | 🟡 P3 | High-contrast temada syntax highlight kontrolü |
| 9.11 | **Uzun kod bloklarında satır numarası** | ⚪ P4 | Chat'teki code block'lara satır numarası ekle |

---

## 10. Ayarlar ve Kişiselleştirme

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 10.1 | Model seçimi | ✅ | Badge + popover |
| 10.2 | Completion enable/disable | ✅ | |
| 10.3 | Debounce ayarı | ✅ | |
| 10.4 | maxTokens ayarı | ✅ | Ayrıca `gemmaAgent.numCtx` ile context window boyutu |
| 10.5 | Dil bazlı completion ayarı | ✅ | `gemmaAgent.completionLanguages` — bkz. 1.8 |
| 10.6 | **Custom system prompt** | 🟡 P3 | Kullanıcı kendi talimatlarını ekleyebilsin |
| 10.7 | **Prompt dosyaları (.prompt.md)** | ⚪ P4 | Tekrar kullanılabilir prompt şablonları |

---

## 11. Kritik Bug'lar ve Güvenilirlik

| # | Sorun | Durum | Açıklama |
|---|---|---|---|
| B1 | Agent run_command timeout / iptal | ✅ | Açık 30 sn timeout (mesajda belirtilir, kısmi çıktı korunur); Stop butonu koşan süreci SIGTERM→SIGKILL ile öldürür |
| B2 | Chat geçmişi context window taşması | ✅ | `src/ollama/contextWindow.ts`: ~4 karakter/token tahmini + `fitMessages` budaması (önce tool-exchange çiftleri, sonra en eski mesajlar); `num_ctx` Ollama'ya gönderilir; UI'da "trimmed" bildirimi |
| B3 | inlineEdit: virtual doc kapandığında hata | ✅ | Virtual-document diff akışı tamamen kaldırıldı (yeni streamed inline edit) |
| B4 | Completion istek yarışı | ✅ | Süpersede edilen isteğin Promise'i artık `null` ile resolve ediliyor (`pendingResolve`) |
| B5 | **Agent'ta edit_file büyük dosyada yavaş** | 🟠 P2 | search string tüm dosyada string includes — büyük dosyalarda yavaş |
| B6 | Status bar 30 sn'de bir poll | ✅ | Event-driven `StatusBarManager`: focus/config/start-stop'ta refresh; bağlantı yokken 5→60 sn backoff, bağlıyken 120 sn |
| B7 | **Panel başlık ikonu SVG — bazı temalarda görünmüyor** | 🟡 P3 | PNG gerektiğini Marketplace zaten uyarıyor |

---

## Kalan Öncelik Sırası

### 🟠 P2 — Kısa vade
1. **3.10** `@workspace` — workspace semantik arama (6.3 indeksleme ile birlikte)
2. **4.9** Agent sonrası tam otomatik lint/build döngüsü (get_diagnostics altyapısı hazır)
3. **1.9** Açık sekmeleri completion bağlamına ekle
4. **5.1 / 5.2** Next Edit Suggestions (NES) — gutter indikatörü
5. **B5** edit_file büyük dosya performansı
6. **3.9** `#sembol` referansları (dosya kısmı tamam)

### 🟡 P3 — Orta vade
7. **10.6** Custom system prompt ayarı
8. **3.11** `@terminal` katılımcısı
9. **9.8** Status bar'da completion spinner
10. **8.6** PR açıklaması üretimi
11. **2.7** Inline edit'te slash komutları

### ⚪ P4 — Uzun vade
12. MCP sunucu desteği
13. Paralel agent oturumları
14. Voice input

---

## Notlar

- **Kelime kelime kabul (1.6)** Copilot kullanıcılarının en sevdiği özellik; Tab'a alternatif, daha kontrollü kabul.
- **Context window yönetimi (B2)** görünmez bir bug'dı; uzun sohbetlerde modeli tamamen kırıyordu — artık çözüldü.
- **Slash komutları (3.8)** yeni kullanıcıları yönlendiriyor; ne yapabileceğini gösteriyor.
- **NES (5.x)** Copilot'ın en büyük differentiator'ı; bir değişiklik yaptıktan sonra "şurası da güncellenmeli" demesi.
- **Workspace indeksleme (6.3)** büyük projeler için şart; küçük projelerde `search_files` yeterli.
- **Inline chat (2.4)** için Copilot'un gerçek floating widget'ı private API — extension'ların erişimi yok; mevcut çözüm Continue.dev'in kullandığı pattern'le aynı.
