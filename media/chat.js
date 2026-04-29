// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  // Elements
  const messagesEl = /** @type {HTMLDivElement} */ (document.getElementById('messages'));
  const emptyState = /** @type {HTMLDivElement} */ (document.getElementById('emptyState'));
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sendBtn'));
  const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById('stopBtn'));
  const clearBtn = /** @type {HTMLButtonElement} */ (document.getElementById('clearBtn'));
  const refreshBtn     = /** @type {HTMLButtonElement} */ (document.getElementById('refreshBtn'));
  const stopOllamaBtn  = /** @type {HTMLButtonElement} */ (document.getElementById('stopOllamaBtn'));
  const modelBadge = /** @type {HTMLButtonElement} */ (document.getElementById('modelBadge'));
  const modelPopover = /** @type {HTMLDivElement} */ (document.getElementById('modelPopover'));
  const ollamaBanner = /** @type {HTMLDivElement} */ (document.getElementById('ollamaBanner'));
  const startOllamaBtn = /** @type {HTMLButtonElement} */ (document.getElementById('startOllamaBtn'));
  const agentPill    = /** @type {HTMLButtonElement} */ (document.getElementById('agentPill'));
  const modeLabel    = /** @type {HTMLSpanElement} */ (document.getElementById('modeLabel'));
  const attachBtn    = /** @type {HTMLButtonElement} */ (document.getElementById('attachBtn'));
  const attachMenu   = /** @type {HTMLDivElement} */ (document.getElementById('attachMenu'));
  const contextChips = /** @type {HTMLDivElement} */ (document.getElementById('contextChips'));

  /** @type {Array<{name: string, content: string, lang: string}>} */
  let attachedContexts = [];
  let attachMenuOpen = false;

  let isGenerating = false;
  let assistantBubble = /** @type {HTMLDivElement|null} */ (null);
  let rawBuffer = '';
  let lastToolCard = /** @type {HTMLDivElement|null} */ (null);
  let installedModels = /** @type {string[]} */ ([]);
  let availableModels = /** @type {string[]} */ ([]);
  let currentModel = 'gemma4:e4b';
  let popoverOpen = false;

  // ── Auto-resize textarea ───────────────────────────────
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
  });

  // ── Send ──────────────────────────────────────────────
  // ── Attach menu ───────────────────────────────────────
  attachBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    attachMenuOpen = !attachMenuOpen;
    attachMenu.classList.toggle('open', attachMenuOpen);
  });

  attachMenu.querySelectorAll('.attach-opt').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      attachMenuOpen = false;
      attachMenu.classList.remove('open');
      vscode.postMessage({ type: 'requestContext', source: /** @type {HTMLButtonElement} */ (btn).dataset.source });
    });
  });

  document.addEventListener('click', () => {
    if (attachMenuOpen) { attachMenuOpen = false; attachMenu.classList.remove('open'); }
  });

  function renderChips() {
    contextChips.innerHTML = '';
    attachedContexts.forEach((ctx, idx) => {
      const chip = document.createElement('div');
      chip.className = 'context-chip';
      chip.innerHTML =
        `<span class="chip-icon">📎</span>` +
        `<span class="chip-name" title="${escapeHtml(ctx.name)}">${escapeHtml(ctx.name)}</span>` +
        `<button class="chip-remove" data-idx="${idx}" title="Kaldır">×</button>`;
      contextChips.appendChild(chip);
    });
    contextChips.style.display = attachedContexts.length ? 'flex' : 'none';
  }

  contextChips.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target);
    if (btn.classList.contains('chip-remove')) {
      const idx = parseInt(btn.dataset.idx || '0', 10);
      attachedContexts.splice(idx, 1);
      renderChips();
    }
  });

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isGenerating) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    hideEmpty();
    const contexts = attachedContexts.length ? [...attachedContexts] : undefined;
    attachedContexts = [];
    renderChips();
    vscode.postMessage({ type: 'sendMessage', text, contexts });
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));

  clearBtn.addEventListener('click', () => {
    messagesEl.innerHTML = '';
    messagesEl.appendChild(emptyState);
    emptyState.style.display = 'flex';
    vscode.postMessage({ type: 'clearHistory' });
  });

  // ── Model picker ──────────────────────────────────────
  modelBadge.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePopover();
  });

  refreshBtn.addEventListener('click', () => {
    refreshBtn.textContent = '…';
    refreshBtn.disabled = true;
    vscode.postMessage({ type: 'refreshModels' });
  });

  stopOllamaBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stopOllama' });
  });

  function togglePopover() {
    popoverOpen = !popoverOpen;
    if (popoverOpen) {
      renderPopover();
      positionPopover();
      modelPopover.classList.add('open');
    } else {
      modelPopover.classList.remove('open');
    }
  }

  function renderPopover() {
    modelPopover.innerHTML = '';

    if (installedModels.length > 0) {
      const header = document.createElement('div');
      header.className = 'popover-section-header';
      header.textContent = '✓ Yüklü modeller';
      modelPopover.appendChild(header);

      installedModels.forEach((m) => {
        const opt = document.createElement('div');
        opt.className = 'model-option installed' + (m === currentModel ? ' selected' : '');
        opt.innerHTML = `<span class="model-dot installed-dot"></span><span>${m}</span><span class="check">✓</span>`;
        opt.addEventListener('click', () => {
          currentModel = m;
          modelBadge.textContent = m;
          modelPopover.classList.remove('open');
          popoverOpen = false;
          vscode.postMessage({ type: 'changeModel', model: m });
        });
        modelPopover.appendChild(opt);
      });
    }

    if (availableModels.length > 0) {
      const header = document.createElement('div');
      header.className = 'popover-section-header';
      header.textContent = '⬇ İndirilebilir modeller';
      modelPopover.appendChild(header);

      availableModels.forEach((m) => {
        const opt = document.createElement('div');
        opt.className = 'model-option available';
        opt.innerHTML = `<span class="model-dot available-dot"></span><span>${m}</span><button class="pull-btn" title="ollama pull ${m}">İndir</button>`;
        opt.querySelector('.pull-btn')?.addEventListener('click', (e) => {
          e.stopPropagation();
          modelPopover.classList.remove('open');
          popoverOpen = false;
          vscode.postMessage({ type: 'pullModel', model: m });
        });
        modelPopover.appendChild(opt);
      });
    }

    if (installedModels.length === 0 && availableModels.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'popover-section-header';
      empty.textContent = 'Ollama çevrimdışı';
      modelPopover.appendChild(empty);
    }
  }

  function positionPopover() {
    const rect = modelBadge.getBoundingClientRect();
    modelPopover.style.top = (rect.bottom + 4) + 'px';
    modelPopover.style.right = '8px';
  }

  document.addEventListener('click', () => {
    if (popoverOpen) { modelPopover.classList.remove('open'); popoverOpen = false; }
  });

  // ── Ollama banner ─────────────────────────────────────
  startOllamaBtn.addEventListener('click', () => {
    startOllamaBtn.textContent = '⏳ Başlatılıyor…';
    startOllamaBtn.disabled = true;
    vscode.postMessage({ type: 'startOllama' });
  });

  // ── Feature pills ─────────────────────────────────────
  document.querySelectorAll('.pill:not(.agent-pill)').forEach((btn) => {
    btn.addEventListener('click', () =>
      vscode.postMessage({ type: 'toggleFeature', feature: /** @type {HTMLButtonElement} */ (btn).dataset.feature })
    );
  });

  agentPill.addEventListener('click', () => vscode.postMessage({ type: 'toggleAgentMode' }));

  // ── Messages from extension ───────────────────────────
  window.addEventListener('message', (e) => {
    const msg = e.data;
    switch (msg.type) {
      case 'init':
        installedModels = msg.installedModels ?? [];
        availableModels = msg.availableModels ?? [];
        currentModel = msg.currentModel ?? 'gemma4:e4b';
        modelBadge.textContent = currentModel;
        applyFeatures(msg.features);
        setOllamaStatus(msg.ollamaRunning);
        setAgentMode(msg.agentMode);
        refreshBtn.textContent = '⟳';
        refreshBtn.disabled = false;
        break;
      case 'settingsUpdate':
        if (msg.currentModel && msg.currentModel !== currentModel) {
          currentModel = msg.currentModel;
          modelBadge.textContent = currentModel;
        }
        applyFeatures(msg.features);
        break;
      case 'modelLoading':
        currentModel = msg.model;
        modelBadge.textContent = '⟳ ' + truncateModel(msg.model);
        modelBadge.disabled = true;
        modelBadge.classList.add('loading');
        break;
      case 'modelReady':
        currentModel = msg.model;
        modelBadge.textContent = truncateModel(msg.model);
        modelBadge.disabled = false;
        modelBadge.classList.remove('loading');
        break;
      case 'agentMode':
        setAgentMode(msg.enabled);
        break;
      case 'userMessage':
        appendUserMessage(msg.text);
        break;
      case 'startAssistant':
        startAssistantBubble();
        break;
      case 'chunk':
        appendChunk(msg.text);
        break;
      case 'toolCall':
        appendToolCard(msg.tool);
        break;
      case 'toolResult':
        finalizeToolCard(msg.result);
        break;
      case 'endAssistant':
        finalizeAssistantBubble();
        break;
      case 'error':
        appendError(msg.text);
        break;
      case 'history':
        restoreHistory(msg.messages);
        break;
      case 'contextAdded':
        attachedContexts.push({ name: msg.name, content: msg.content, lang: msg.lang });
        renderChips();
        break;
      case 'contextError':
        vscode.postMessage({ type: 'showError' }); // fallback
        appendError(msg.message);
        break;
    }
  });

  // ── State helpers ─────────────────────────────────────
  function truncateModel(name) { return name; } // badge CSS zaten ellipsis yapıyor

  function setOllamaStatus(running) {
    ollamaBanner.style.display = running ? 'none' : 'flex';
    if (running) { startOllamaBtn.textContent = '▶ Başlat'; startOllamaBtn.disabled = false; }
  }

  function setAgentMode(enabled) {
    agentPill.classList.toggle('active', enabled);
    agentPill.classList.toggle('inactive', !enabled);
    modeLabel.textContent = enabled ? '⚡ Agent' : 'Chat';
    modeLabel.className = 'modeLabel' + (enabled ? ' agent' : '');
    inputEl.placeholder = enabled
      ? 'Agent: dosya oluştur, düzenle, komut çalıştır… (Enter)'
      : 'Mesaj yaz… (Enter gönder, Shift+Enter yeni satır)';
  }

  function applyFeatures(features) {
    document.querySelectorAll('.pill:not(.agent-pill)').forEach((btn) => {
      const b = /** @type {HTMLButtonElement} */ (btn);
      const on = features[b.dataset.feature ?? ''] !== false;
      b.classList.toggle('active', on);
      b.classList.toggle('inactive', !on);
    });
  }

  function hideEmpty() {
    if (emptyState.parentNode === messagesEl) messagesEl.removeChild(emptyState);
  }

  function setInputDisabled(disabled) {
    sendBtn.disabled = disabled;
    sendBtn.style.display = disabled ? 'none' : 'flex';
    stopBtn.style.display = disabled ? 'flex' : 'none';
  }

  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  // ── Message builders ──────────────────────────────────
  function appendUserMessage(text) {
    hideEmpty();
    const wrap = document.createElement('div');
    wrap.className = 'message user';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function startAssistantBubble() {
    isGenerating = true;
    rawBuffer = '';
    setInputDisabled(true);
    hideEmpty();

    const wrap = document.createElement('div');
    wrap.className = 'message assistant';

    const header = document.createElement('div');
    header.className = 'msg-header';
    header.innerHTML = '<div class="msg-avatar">G</div><span class="msg-name">Gemma</span>';

    assistantBubble = document.createElement('div');
    assistantBubble.className = 'bubble';
    assistantBubble.innerHTML = '<div class="typing-dots"><div class="dot"></div><div class="dot"></div><div class="dot"></div></div>';

    wrap.appendChild(header);
    wrap.appendChild(assistantBubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  function appendChunk(text) {
    if (!assistantBubble) return;
    rawBuffer += text;
    assistantBubble.innerHTML = renderMarkdown(rawBuffer);
    scrollToBottom();
  }

  function finalizeAssistantBubble() {
    isGenerating = false;
    setInputDisabled(false);
    if (assistantBubble) {
      if (!rawBuffer.trim()) {
        // Agent only did tool calls — remove empty bubble
        assistantBubble.closest('.message')?.remove();
      } else {
        addCodeBlockButtons(assistantBubble);
      }
    }
    assistantBubble = null;
    rawBuffer = '';
    inputEl.focus();
  }

  function appendError(text) {
    isGenerating = false;
    rawBuffer = '';
    setInputDisabled(false);
    // Remove typing bubble if still present
    assistantBubble?.closest('.message')?.remove();
    assistantBubble = null;
    hideEmpty();

    const wrap = document.createElement('div');
    wrap.className = 'message error';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = '⚠ ' + text;
    wrap.appendChild(bubble);
    messagesEl.appendChild(wrap);
    scrollToBottom();
  }

  // ── Tool cards ────────────────────────────────────────
  const TOOL_META = {
    create_file:  { emoji: '📄', label: 'Dosya oluştur' },
    edit_file:    { emoji: '✏️', label: 'Dosya düzenle' },
    read_file:    { emoji: '📖', label: 'Dosya oku' },
    run_command:  { emoji: '⚡', label: 'Komut çalıştır' },
    list_files:   { emoji: '📁', label: 'Dizin listele' },
    search_files: { emoji: '🔍', label: 'Dosya ara' },
  };

  function appendToolCard(tool) {
    const meta = TOOL_META[tool.tool] ?? { emoji: '⚙', label: tool.tool };
    const arg = tool.path ?? tool.command ?? tool.query ?? '';

    const card = document.createElement('div');
    card.className = 'tool-card running';
    card.innerHTML = `
      <div class="tool-card-left">
        <span class="tool-emoji">${meta.emoji}</span>
        <span class="tool-name">${meta.label}</span>
      </div>
      <span class="tool-arg" title="${escapeHtml(arg)}">${escapeHtml(arg)}</span>
      <span class="tool-status-badge">çalışıyor…</span>`;

    messagesEl.appendChild(card);
    lastToolCard = card;
    scrollToBottom();
  }

  function finalizeToolCard(result) {
    if (!lastToolCard) return;
    lastToolCard.classList.remove('running');
    lastToolCard.classList.add(result.ok ? 'success' : 'failure');
    const badge = lastToolCard.querySelector('.tool-status-badge');
    if (badge) badge.textContent = result.ok ? '✓ Tamam' : '✗ Hata';

    if (result.output && result.output.length > 15) {
      const details = document.createElement('details');
      details.className = 'tool-output-toggle';
      const pre = document.createElement('pre');
      pre.className = 'tool-output-pre';
      pre.textContent = result.output;
      details.innerHTML = '<summary>Çıktıyı göster</summary>';
      details.appendChild(pre);
      lastToolCard.appendChild(details);
    }
    lastToolCard = null;
    scrollToBottom();
  }

  // ── Syntax highlighter ────────────────────────────────
  const HL_KW = {
    python:     new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' ')),
    javascript: new Set('async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new null of return static super switch this throw true false try typeof undefined var void while with yield'.split(' ')),
    typescript: new Set('abstract any as async await boolean break case catch class const continue debugger declare default delete do else enum export extends finally for from function if implements import in instanceof interface keyof let namespace never new null number object of override private protected public readonly return static string super switch symbol this throw true false try type typeof undefined unknown var void while with yield'.split(' ')),
    c:          new Set('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while NULL true false'.split(' ')),
    go:         new Set('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var true false nil iota'.split(' ')),
    rust:       new Set('as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type union unsafe use where while'.split(' ')),
    java:       new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true false try var void volatile while record sealed permits'.split(' ')),
    csharp:     new Set('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while'.split(' ')),
  };
  HL_KW.js = HL_KW.javascript; HL_KW.ts = HL_KW.typescript;
  HL_KW.jsx = HL_KW.javascript; HL_KW.tsx = HL_KW.typescript;
  HL_KW['c++'] = HL_KW.cpp = new Set([
    ...HL_KW.c,
    ...('alignas alignof and and_eq asm bitand bitor bool catch class compl concept const_cast consteval constexpr constinit co_await co_return co_yield decltype delete dynamic_cast explicit export false friend mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public reinterpret_cast requires static_assert static_cast template thread_local throw true try typeid typename using virtual wchar_t xor xor_eq'.split(' ')),
  ]);
  HL_KW.cs = HL_KW.csharp;

  const HL_BI = {
    python:     new Set('print len range type int str float list dict set tuple bool open input enumerate zip map filter sorted reversed sum min max abs round isinstance issubclass hasattr getattr setattr super staticmethod classmethod property'.split(' ')),
    javascript: new Set('console Math JSON Array Object String Number Boolean Promise Error Date RegExp Symbol Map Set setTimeout setInterval clearTimeout clearInterval fetch require module exports parseInt parseFloat isNaN isFinite'.split(' ')),
    c:          new Set('printf scanf fprintf fscanf sprintf sscanf malloc calloc realloc free strlen strcpy strcat strcmp strncpy strncat strncmp memcpy memset memmove memcmp abort exit fopen fclose fread fwrite fgets fputs puts getchar putchar atoi atof strtol'.split(' ')),
    go:         new Set('fmt len cap make new append copy delete close panic recover print println'.split(' ')),
    rust:       new Set('println print vec Some None Ok Err Box Vec String HashMap HashSet Option Result panic assert assert_eq assert_ne unreachable todo unimplemented'.split(' ')),
    java:       new Set('System String Integer Double Float Long Boolean Character Math Object Arrays List ArrayList HashMap HashSet println print format toString valueOf parseInt parseDouble'.split(' ')),
  };
  HL_BI.js = HL_BI.javascript; HL_BI.ts = HL_BI.javascript;
  HL_BI.jsx = HL_BI.javascript; HL_BI.tsx = HL_BI.javascript;
  HL_BI['c++'] = HL_BI.cpp = new Set([
    ...HL_BI.c,
    ...('std cout cin cerr endl vector string map set unordered_map unordered_set list deque queue stack pair tuple make_pair make_tuple swap move forward unique_ptr shared_ptr weak_ptr make_unique make_shared dynamic_pointer_cast begin end size push_back pop_back emplace_back'.split(' ')),
  ]);
  HL_BI.cs = HL_BI.csharp = new Set('Console Math Convert String Int32 Double List Dictionary HashSet Array Task Thread Environment DateTime'.split(' '));

  function highlight(code, lang) {
    const kw     = HL_KW[lang] || new Set();
    const bi     = HL_BI[lang] || new Set();
    const isPy   = lang === 'python' || lang === 'py';
    const isJS   = /^(javascript|typescript|js|ts|jsx|tsx)$/.test(lang);
    const isBash = /^(bash|sh|shell|shellscript)$/.test(lang);
    const isC    = /^(c|cpp|c\+\+|objectivec|objective-c)$/.test(lang);
    const isJava = /^(java|kotlin|csharp|cs|scala)$/.test(lang);
    // Languages with C-style // and /* */ comments
    const hasCComment = isJS || isC || isJava || /^(go|rust|swift)$/.test(lang);

    let out = '', i = 0;
    const s = code;
    const n = s.length;

    function span(cls, text) { out += `<span class="hl-${cls}">${escapeHtml(text)}</span>`; }
    function plain(text)     { out += escapeHtml(text); }

    while (i < n) {
      const ch = s[i];

      // Block comment /* ... */
      if (hasCComment && ch === '/' && s[i+1] === '*') {
        const end = s.indexOf('*/', i + 2);
        const t = end === -1 ? s.slice(i) : s.slice(i, end + 2);
        span('cm', t); i += t.length; continue;
      }
      // Line comment //
      if (hasCComment && ch === '/' && s[i+1] === '/') {
        const end = s.indexOf('\n', i);
        const t = end === -1 ? s.slice(i) : s.slice(i, end);
        span('cm', t); i += t.length; continue;
      }
      // Preprocessor directive #include #define etc. (C/C++)
      if (isC && ch === '#') {
        const lineStart = s.lastIndexOf('\n', i - 1) + 1;
        const beforeHash = s.slice(lineStart, i);
        if (beforeHash.trim() === '') {
          const end = s.indexOf('\n', i);
          const t = end === -1 ? s.slice(i) : s.slice(i, end);
          span('pp', t); i += t.length; continue;
        }
      }
      // Line comment # (Python / Bash)
      if ((isPy || isBash) && ch === '#') {
        const end = s.indexOf('\n', i);
        const t = end === -1 ? s.slice(i) : s.slice(i, end);
        span('cm', t); i += t.length; continue;
      }
      // Rust/Kotlin doc comment ///
      if (lang === 'rust' && ch === '/' && s[i+1] === '/' && s[i+2] === '/') {
        const end = s.indexOf('\n', i);
        const t = end === -1 ? s.slice(i) : s.slice(i, end);
        span('cm', t); i += t.length; continue;
      }
      // Triple-quoted string (Python)
      if (isPy && (s.slice(i, i+3) === '"""' || s.slice(i, i+3) === "'''")) {
        const q = s.slice(i, i+3);
        const end = s.indexOf(q, i + 3);
        const t = end === -1 ? s.slice(i) : s.slice(i, end + 3);
        span('st', t); i += t.length; continue;
      }
      // String " ' ` (backtick only for JS/TS)
      if (ch === '"' || ch === "'" || (isJS && ch === '`')) {
        let j = i + 1;
        while (j < n) {
          if (s[j] === '\\') { j += 2; continue; }
          if (s[j] === ch)   { j++; break; }
          // Don't cross newlines for single/double quoted (except template literals)
          if (ch !== '`' && s[j] === '\n') break;
          j++;
        }
        span('st', s.slice(i, j)); i = j; continue;
      }
      // Number (decimal, hex, binary, float, suffixes like 1u, 1L, 1.0f)
      if (ch >= '0' && ch <= '9') {
        let j = i;
        if (ch === '0' && /[xXbBoO]/.test(s[i+1])) {
          j += 2; while (j < n && /[0-9a-fA-F_]/.test(s[j])) j++;
        } else {
          while (j < n && /[\d._]/.test(s[j])) j++;
          if (j < n && /[eE]/.test(s[j])) { j++; if (/[+-]/.test(s[j])) j++; while (j < n && /\d/.test(s[j])) j++; }
        }
        // Numeric suffixes: u, l, f, ul, ll, etc.
        while (j < n && /[uUlLfF]/.test(s[j])) j++;
        span('nm', s.slice(i, j)); i = j; continue;
      }
      // Decorator/annotation: @name (Python, Java, C#, Rust #[...])
      if (ch === '@' && /[a-zA-Z_]/.test(s[i+1])) {
        let j = i + 1; while (j < n && /[\w.]/.test(s[j])) j++;
        span('dc', s.slice(i, j)); i = j; continue;
      }
      // Identifier / keyword / builtin / function
      if (/[a-zA-Z_$]/.test(ch)) {
        let j = i + 1; while (j < n && /[\w$]/.test(s[j])) j++;
        const word = s.slice(i, j);
        let k = j; while (k < n && (s[k] === ' ' || s[k] === '\t')) k++;
        const isCall = s[k] === '(';
        if (kw.has(word))      span('kw', word);
        else if (bi.has(word)) span('bi', word);
        else if (isCall)       span('fn', word);
        else                   plain(word);
        i = j; continue;
      }
      plain(ch); i++;
    }
    return out;
  }

  // ── Markdown renderer ─────────────────────────────────
  function renderMarkdown(text) {
    const parts = [];
    let last = 0;
    const codeRe = /```(\w*)\n?([\s\S]*?)```/g;
    let m;
    while ((m = codeRe.exec(text)) !== null) {
      if (m.index > last) parts.push(renderInline(text.slice(last, m.index)));
      const lang = (m[1] || 'code').toLowerCase();
      const code = m[2].trim();
      const highlighted = highlight(code, lang);
      parts.push(
        `<div class="code-block" data-code="${encodeURIComponent(code)}">` +
          `<div class="code-header"><span class="code-lang">${escapeHtml(lang)}</span>` +
          `<button class="copy-btn">Kopyala</button></div>` +
          `<pre><code>${highlighted}</code></pre>` +
        `</div>`
      );
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(renderInline(text.slice(last)));
    return parts.join('');
  }

  function renderInline(text) {
    text = text.replace(/`([^`]+)`/g, (_, c) => `<code>${escapeHtml(c)}</code>`);
    text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
    text = text.replace(/^#{1,6} (.+)$/gm, (_, content) => `<strong>${content}</strong>`);
    text = text.replace(/^---+$/gm, '<hr>');
    text = text.replace(/\n/g, '<br>');
    return text;
  }

  function escapeHtml(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── History restore ───────────────────────────────────
  function restoreHistory(messages) {
    if (!messages || messages.length === 0) return;
    hideEmpty();
    messages.forEach((msg) => {
      if (msg.role === 'user') {
        appendUserMessage(msg.content);
      } else if (msg.role === 'assistant' && msg.content) {
        const wrap = document.createElement('div');
        wrap.className = 'message assistant';
        const header = document.createElement('div');
        header.className = 'msg-header';
        header.innerHTML = '<div class="msg-avatar">G</div><span class="msg-name">Gemma</span>';
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.innerHTML = renderMarkdown(msg.content);
        wrap.appendChild(header);
        wrap.appendChild(bubble);
        messagesEl.appendChild(wrap);
        addCodeBlockButtons(bubble);
      }
    });
    scrollToBottom();
  }

  function addCodeBlockButtons(bubble) {
    bubble.querySelectorAll('.code-block[data-code]').forEach((block) => {
      const code = decodeURIComponent(block.getAttribute('data-code') || '');
      const copyBtn = block.querySelector('.copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(code).then(() => {
            copyBtn.innerHTML = '&#10003;';
            copyBtn.classList.add('copied');
            setTimeout(() => { copyBtn.innerHTML = 'Kopyala'; copyBtn.classList.remove('copied'); }, 1500);
          });
        });
      }
      const insertBtn = document.createElement('button');
      insertBtn.className = 'insert-btn';
      insertBtn.textContent = '↩ Editöre ekle';
      insertBtn.addEventListener('click', () => vscode.postMessage({ type: 'insertCode', code }));
      block.after(insertBtn);
    });
  }
})();
