# Copilot Feature Parity — Yol Haritası

GitHub Copilot'ı kaliteli yapan özelliklerin araştırılmasıyla oluşturulmuş, Gemma Agent için önceliklendirilmiş uygulama listesi.

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
| 1.6 | **Kelime kelime kabul** | 🔴 P1 | `Cmd+→` ile öneriyi tek kelime/satır kabul et — Copilot'un en sevilen özelliği |
| 1.7 | **Alternatif öneriler arası geçiş** | 🟠 P2 | `Alt+]` / `Alt+[` ile birden fazla completion arasında gezin; mevcut kod sadece 1 tane üretiyor |
| 1.8 | **Dil bazlı enable/disable** | 🟠 P2 | Örn. Markdown'da kapalı, TypeScript'te açık; `gemmaAgent.completionLanguages` ayarı |
| 1.9 | **Completion'da açık sekmeleri bağlam olarak kullan** | 🟠 P2 | Sadece aktif dosyayı değil, editörde açık diğer dosyaları da prefix olarak ekle |
| 1.10 | **Minimum token eşiği** | 🟡 P3 | Çok kısa (`<3 karakter`) veya sadece boşluk olan satırlarda tetiklenmemeli — kısmen var |
| 1.11 | **`///` / `/**` yorumda docstring üretimi** | 🟡 P3 | Yorum satırı açılınca otomatik fonksiyon dokümantasyonu üret |

---

## 2. Inline Chat (Editör İçi Chat)

Copilot'ta `Cmd+I` ile editörün içinde, seçili kod üzerinde doğrudan sohbet penceresi açılır. Mevcut `inlineEdit` bunun yalnızca bir kısmını karşılıyor.

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 2.1 | Seçili kod üzerinde inline düzenleme | ✅ | `Cmd+Shift+I`, instruction gir, diff önizle, uygula |
| 2.2 | Diff önizleme (vscode.diff) | ✅ | Apply öncesi görsel karşılaştırma |
| 2.3 | WorkspaceEdit ile uygulama | ✅ | Undo stack çalışıyor |
| 2.4 | **Inline chat widget** (editörün içinde floating input) | 🔴 P1 | Copilot'ta ayrı panel açmadan, seçimi in-place düzenlenir; stream edilen cevap mevcut kodun yerine direkt yazılır ve `Accept`/`Discard` CodeLens çıkar |
| 2.5 | **Stream edilen diff** | 🟠 P2 | Yanıt gelirken satır satır diff'i güncelle; şu an tüm yanıt geldikten sonra diff açılıyor |
| 2.6 | **Seçimsiz inline chat** | 🟠 P2 | Seçim olmadan `Cmd+I` ile cursor pozisyonuna kod ekle |
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
| 3.6 | Regenerate son yanıt | ✅ | ↺ butonu |
| 3.7 | **Geçmişi session'lar arası koru** | 🔴 P1 | VS Code'u yeniden başlatınca tüm sohbet siliniyor; `ExtensionContext.globalState` ile persist et |
| 3.8 | **Slash komutları** | 🔴 P1 | `/explain`, `/fix`, `/tests`, `/new`, `/docs` — chat'e `/` yazınca öneri menüsü |
| 3.9 | **`#dosya` ve `#sembol` referansları** | 🟠 P2 | Chat'e yazarken `#` ile dosya/sembol seç; kontekste otomatik eklenir |
| 3.10 | **`@workspace` katılımcısı** | 🟠 P2 | Tüm workspace'i semantik olarak arar; `@workspace neden bu fonksiyon yavaş?` sorulabilir |
| 3.11 | **`@terminal` katılımcısı** | 🟠 P2 | Son terminal çıktısını bağlam olarak alır; hata mesajlarını açıklar |
| 3.12 | **Quick Chat** (floating, non-blocking) | 🟡 P3 | Yan panel açmadan hızlı soru sor; `Cmd+Shift+Alt+L` benzeri kısayol |
| 3.13 | **Birden fazla chat oturumu** | 🟡 P3 | Oturumları adlandır, listele, switch et |
| 3.14 | **Görsel / ekran görüntüsü ekleme** | ⚪ P4 | Multimodal model varsa screenshot'ı bağlam olarak ekle |

---

## 4. Agent Modu

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 4.1 | Tool-call döngüsü (create/edit/read/run) | ✅ | XML wrapper format |
| 4.2 | Canlı adım göstergesi (agentThinking) | ✅ | Spinner + "step 2/10" |
| 4.3 | Tool kart UI (çalışıyor/başarı/hata) | ✅ | Çıktı göster/gizle |
| 4.4 | run_command stdout/stderr yakalama | ✅ | |
| 4.5 | Path traversal güvenliği | ✅ | Workspace dışına çıkamaz |
| 4.6 | Configurable maxIterations | ✅ | |
| 4.7 | **"Undo Last Edit" butonu** | 🔴 P1 | Agent düzenleme yaptıktan sonra tüm değişiklikleri geri al; Copilot'ta her step için geri alınabilir |
| 4.8 | **Terminal komutlarında onay adımı** | 🔴 P1 | Copilot, `run_command` öncesi kullanıcıya onay sorar; şu an direkt çalıştırılıyor (güvenlik riski) |
| 4.9 | **Compile/lint hataları otomatik düzelt** | 🟠 P2 | Agent düzenleme sonrası `npm run build` / `tsc` çalıştır, hata varsa düzelt — kendi kendini düzelten döngü |
| 4.10 | **Multi-dosya diff özeti** | 🟠 P2 | Agent görev bitince değişen dosyaları ve satır sayılarını listele |
| 4.11 | **Agent task geçmişi** | 🟡 P3 | Tamamlanan görevleri listele, tekrar çalıştır |
| 4.12 | **Paralel agent oturumları** | ⚪ P4 | Birden fazla agent task'ı aynı anda çalıştır |

---

## 5. Next Edit Suggestions (NES) — Tahminsel Düzenleme

Copilot'un en yenilikçi özelliği: sadece cursor'ın bulunduğu yeri tamamlamakla kalmaz, kodun *başka neresinin* düzenlenmesi gerektiğini de tahmin eder.

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
| 6.2 | Seçim ve dosya chip'leri | ✅ | Chat için |
| 6.3 | **Workspace indeksleme** | 🟠 P2 | Tüm dosyaları vektörsel olarak indeksle; `@workspace` sorularında semantik arama yap |
| 6.4 | **`package.json`, `tsconfig.json` otomatik bağlamı** | 🟡 P3 | Config dosyalarını her istek için sessizce ekle; model projeyi daha iyi anlar |
| 6.5 | **Son terminal çıktısını otomatik yakala** | 🟡 P3 | Agent veya chat başlamadan önce aktif terminal'ın son N satırını bağlama ekle |
| 6.6 | **Git diff bağlamı** | 🟡 P3 | `git diff HEAD` çıktısını `@changes` ile chat'e ekle |

---

## 7. Hata Ayıklama ve Terminal Entegrasyonu

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 7.1 | Terminal'de komut çalıştırma (agent) | ✅ | run_command ile |
| 7.2 | runInTerminal komutu | ✅ | Seçili kodu terminale gönder |
| 7.3 | **Terminal'de inline chat** | 🟠 P2 | Terminal içinde `Cmd+I` → "bu hatayı açıkla / düzelt" |
| 7.4 | **Hata mesajlarını otomatik tanı** | 🟠 P2 | Terminal'de kırmızı çıktı göründüğünde bildirim + "Copilot ile düzelt" butonu |
| 7.5 | **Shell komut önerisi** | 🟡 P3 | "nasıl X yaparım" sorusuna direkt terminal komutu üret |

---

## 8. Kod İnceleme ve Kalite

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 8.1 | Kodu açıkla (explain) | ✅ | Sağ tık → context menu |
| 8.2 | Refactor | ✅ | |
| 8.3 | Fix | ✅ | |
| 8.4 | Test üret | ✅ | |
| 8.5 | **Commit mesajı üret** | 🟠 P2 | `git diff --staged` çıktısını alıp anlamlı commit mesajı öner; SCM input box'a yaz |
| 8.6 | **PR özeti üret** | 🟡 P3 | `git log` ve `git diff` bazlı PR açıklaması yaz |
| 8.7 | **Güvenlik açığı tespiti** | 🟡 P3 | Kod incelemesinde SQL injection, XSS, hardcoded secret gibi yaygın açıkları işaretle |
| 8.8 | **Kod karmaşıklığı / kalite önerisi** | ⚪ P4 | Cyclomatic complexity, dead code, unused import gibi statik analiz ipuçları |

---

## 9. UI / UX Kalitesi

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 9.1 | Status bar entegrasyonu | ✅ | Model adı + bağlantı durumu |
| 9.2 | RAF-batched streaming | ✅ | Jank yok |
| 9.3 | Scroll-to-bottom butonu | ✅ | |
| 9.4 | Escape ile popover/üretim durdur | ✅ | |
| 9.5 | Üretim sırasında clear guard | ✅ | |
| 9.6 | Regenerate butonu | ✅ | |
| 9.7 | **Typing indicator'ı modele özel göster** | 🟡 P3 | "gemma3:4b düşünüyor…" yerine sadece nokta animasyonu — zaten var ama model adı eklenebilir |
| 9.8 | **Completion tetiklenme göstergesi** | 🟡 P3 | Status bar'da "Gemma: üretiyor…" spinner — Copilot'ta sağ altta küçük spinner gösterir |
| 9.9 | **Hata durumunda akıllı mesaj** | 🟡 P3 | Bağlantı hatası, model bulunamadı, timeout ayrı mesajlarla ele alınsın |
| 9.10 | **Renk teması uyumu (high contrast)** | 🟡 P3 | High-contrast temada syntax highlight renkleri düzgün görünüyor mu kontrol et |
| 9.11 | **Uzun kod bloklarında satır numarası** | ⚪ P4 | Chat'teki code block'lara satır numarası ekle |

---

## 10. Ayarlar ve Kişiselleştirme

| # | Özellik | Durum | Açıklama |
|---|---|---|---|
| 10.1 | Model seçimi | ✅ | Badge + popover |
| 10.2 | Completion enable/disable | ✅ | |
| 10.3 | Debounce ayarı | ✅ | |
| 10.4 | maxTokens ayarı | ✅ | |
| 10.5 | **Dil bazlı completion ayarı** | 🟠 P2 | `"gemmaAgent.completionLanguages": ["typescript","python"]` — listede olmayan dillerde completion devre dışı |
| 10.6 | **Custom system prompt** | 🟡 P3 | Kullanıcı kendi talimatlarını ekleyebilsin; "Her zaman Türkçe yanıt ver" veya "daima test yaz" |
| 10.7 | **Prompt dosyaları (.prompt.md)** | ⚪ P4 | Workspace'e `.gemma/` klasörü ekle, tekrar kullanılabilir prompt şablonları |

---

## 11. Kritik Bug'lar ve Güvenilirlik

Copilot'ın avantajının büyük kısmı özellik sayısından değil, **tutarlı çalışmasından** geliyor.

| # | Sorun | Öncelik | Açıklama |
|---|---|---|---|
| B1 | **Agent run_command'da timeout yok — VS Code donabilir** | 🔴 P1 | 30 saniyelik timeout var ama kullanıcıya geri bildirim yok; spinner + iptal butonu olmalı |
| B2 | **Chat geçmişi context window taşarsa model bozulur** | 🔴 P1 | Çok uzun sohbette son N mesajı tut veya özetle; token limiti aşılınca sessizce boş yanıt geliyor |
| B3 | **inlineEdit: virtual doc kapandığında hata** | 🟠 P2 | Diff görüntülenirken dosya kapatılırsa hata fırlatıyor |
| B4 | **Completion'da aynı anda birden fazla istek yarışı** | 🟠 P2 | Debounce var ama hızlı yazıda abort bazen başarısız oluyor; race condition |
| B5 | **Agent'ta edit_file büyük dosyada yavaş** | 🟠 P2 | search string tüm dosyada string includes — büyük dosyalarda yavaş |
| B6 | **Status bar Ollama check her 30 saniyede istek atıyor** | 🟡 P3 | Background polling yerine connection error'da retry mantığı daha temiz |
| B7 | **Panel başlık ikonu SVG — bazı temalarda görünmüyor** | 🟡 P3 | PNG gerektiğini Marketplace zaten uyarıyor |

---

## Öncelik Sırası (Implementasyon Sırası)

### 🔴 P1 — Hemen (Kullanıcıyı direkt etkileyen)
1. **B2** Chat geçmişi context window yönetimi (en kritik — sessiz bozulmaya yol açıyor)
2. **3.7** Geçmişi session'lar arası koru (`globalState`)
3. **3.8** Slash komutları (`/explain`, `/fix`, `/tests`)
4. **1.6** Kelime kelime completion kabul (`Cmd+→`)
5. **4.8** run_command'da kullanıcı onayı
6. **4.7** Agent "Undo Last Edit" butonu
7. **2.4** Inline chat widget (editör içi floating input)

### 🟠 P2 — Kısa vade (Copilot'a yaklaşmak için)
8. **1.7** Alternatif completion önerileri arası geçiş
9. **3.9** `#dosya` ve `#sembol` referansları
10. **3.10** `@workspace` — workspace semantik arama
11. **4.9** Agent sonrası otomatik lint/build döngüsü
12. **8.5** Commit mesajı üretimi
13. **10.5** Dil bazlı completion enable/disable
14. **1.9** Açık sekmeleri completion bağlamına ekle
15. **5.1 / 5.2** Next Edit Suggestions (NES) — gutter indikatörü

### 🟡 P3 — Orta vade (Kalite ve cilalama)
16. **10.6** Custom system prompt ayarı
17. **3.11** `@terminal` katılımcısı
18. **9.8** Status bar'da completion spinner
19. **8.6** Commit mesajı (SCM entegrasyonu)

### ⚪ P4 — Uzun vade (İleri özellikler)
20. MCP sunucu desteği
21. Paralel agent oturumları
22. Voice input

---

## Notlar

- **Kelime kelime kabul (1.6)** Copilot kullanıcılarının en sevdiği özellik; Tab'a alternatif, daha kontrollü kabul.
- **Context window yönetimi (B2)** görünmez bir bug; fark etmesi zor ama uzun sohbetlerde modeli tamamen kırıyor.
- **Slash komutları (3.8)** yeni kullanıcıları yönlendiriyor; ne yapabileceğini gösteriyor.
- **NES (5.x)** Copilot'ın 2025'teki en büyük differentiator'ı; bir değişiklik yaptıktan sonra "şurası da güncellenmeli" demesi bunu çok zekice yapıyor.
- **Workspace indeksleme (3.10)** büyük projeler için şart; küçük projelerde `search_files` yeterli.
