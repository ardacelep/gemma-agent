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
  const setupView = /** @type {HTMLDivElement} */ (document.getElementById('setupView'));
  const messagesWrapper = /** @type {HTMLDivElement} */ (document.getElementById('messagesWrapper'));
  const inputArea = /** @type {HTMLDivElement} */ (document.getElementById('inputArea'));
  const pillBar = /** @type {HTMLDivElement} */ (document.getElementById('pillBar'));
  const sessionsBtn = /** @type {HTMLButtonElement} */ (document.getElementById('sessionsBtn'));
  const newChatBtn = /** @type {HTMLButtonElement} */ (document.getElementById('newChatBtn'));
  const sessionPopover = /** @type {HTMLDivElement} */ (document.getElementById('sessionPopover'));
  const agentPill    = /** @type {HTMLButtonElement} */ (document.getElementById('agentPill'));
  const modeLabel    = /** @type {HTMLSpanElement} */ (document.getElementById('modeLabel'));
  const attachBtn    = /** @type {HTMLButtonElement} */ (document.getElementById('attachBtn'));
  const attachMenu   = /** @type {HTMLDivElement} */ (document.getElementById('attachMenu'));
  const contextChips = /** @type {HTMLDivElement} */ (document.getElementById('contextChips'));
  const scrollToBottomBtn = /** @type {HTMLButtonElement} */ (document.getElementById('scrollToBottomBtn'));
  const inputWrapper = /** @type {HTMLDivElement} */ (document.getElementById('inputWrapper'));

  /** @type {Array<{name: string, content: string, lang: string}>} */
  let attachedContexts = [];
  let attachMenuOpen = false;

  let isGenerating = false;
  let assistantBubble = /** @type {HTMLDivElement|null} */ (null);
  let rawBuffer = '';
  let pendingChunks = '';
  let rafPending = false;
  let lastToolCard = /** @type {HTMLDivElement|null} */ (null);
  let thinkingIndicator = /** @type {HTMLDivElement|null} */ (null);
  let installedModels = /** @type {string[]} */ ([]);
  let availableModels = /** @type {string[]} */ ([]);
  let currentModel = '';
  let popoverOpen = false;
  let userScrolledUp = false;
  let capabilities = { canPull: true, canWarmup: true, canUnload: true, canStartStopServer: true, canListAvailable: true };
  let serverState = 'unknown';
  let pulls = /** @type {Record<string,{status:string,percent?:number}>} */ ({});
  let recommendedModel = 'gemma4:e4b';
  /** @type {Array<{id:string,title:string,updatedAt:number}>} */
  let sessions = [];
  let activeSessionId = '';
  let sessionPopoverOpen = false;

  /** @type {Array<{name: string, description: string}>} */
  let slashCommands = [];

  // ── Command popup (slash commands + #file references) ─
  const cmdPopover = document.createElement('div');
  cmdPopover.id = 'cmdPopover';
  document.body.appendChild(cmdPopover);
  let cmdPopoverOpen = false;
  /** @type {Array<{name: string, description: string}>} */
  let cmdItems = [];
  let cmdSelected = 0;
  /** @type {'slash' | 'file'} */
  let cmdMode = 'slash';
  let fileQueryDebounce;
  const FILE_REF_RE = /(^|\s)#([\w./\\-]*)$/;

  function openCmdPopover(items) {
    cmdItems = items;
    cmdSelected = 0;
    renderCmdPopover();
    cmdPopover.classList.add('open');
    cmdPopoverOpen = true;
  }

  function closeCmdPopover() {
    cmdPopoverOpen = false;
    cmdPopover.classList.remove('open');
  }

  function renderCmdPopover() {
    cmdPopover.innerHTML = '';
    cmdItems.forEach((item, idx) => {
      const row = document.createElement('div');
      row.className = 'cmd-option' + (idx === cmdSelected ? ' selected' : '');
      row.innerHTML = cmdMode === 'file'
        ? `<span class="cmd-name">📄 ${escapeHtml(item.name)}</span>`
        : `<span class="cmd-name">/${escapeHtml(item.name)}</span>` +
          `<span class="cmd-desc">${escapeHtml(item.description)}</span>`;
      row.addEventListener('click', (e) => { e.stopPropagation(); applyCmdSelection(idx); });
      cmdPopover.appendChild(row);
    });
    positionCmdPopover();
  }

  function positionCmdPopover() {
    const rect = inputWrapper.getBoundingClientRect();
    cmdPopover.style.left = rect.left + 'px';
    cmdPopover.style.width = rect.width + 'px';
    cmdPopover.style.bottom = (window.innerHeight - rect.top + 4) + 'px';
  }

  function applyCmdSelection(idx) {
    const item = cmdItems[idx];
    if (!item) return;
    if (cmdMode === 'file') {
      // Remove the typed #partial and attach the file (or terminal output) as a chip
      inputEl.value = inputEl.value.replace(FILE_REF_RE, '$1');
      if (item.name.startsWith('#terminal')) {
        vscode.postMessage({ type: 'attachTerminal' });
      } else {
        vscode.postMessage({ type: 'attachFile', path: item.name });
      }
    } else {
      inputEl.value = '/' + item.name + ' ';
    }
    closeCmdPopover();
    inputEl.focus();
  }

  function updateCmdPopover() {
    const slashM = /^\/(\w*)$/.exec(inputEl.value);
    if (slashM && slashCommands.length) {
      const filtered = slashCommands.filter((c) => c.name.startsWith(slashM[1].toLowerCase()));
      if (filtered.length) { cmdMode = 'slash'; openCmdPopover(filtered); return; }
    }
    const fileM = FILE_REF_RE.exec(inputEl.value);
    if (fileM) {
      cmdMode = 'file';
      clearTimeout(fileQueryDebounce);
      fileQueryDebounce = setTimeout(() => {
        vscode.postMessage({ type: 'requestFileList', query: fileM[2] });
      }, 150);
      return; // popup opens (or refreshes) when the fileList answer arrives
    }
    closeCmdPopover();
  }

  // ── Scroll tracking for sticky button ────────────────
  messagesEl.addEventListener('scroll', () => {
    const threshold = 80;
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
    userScrolledUp = !atBottom;
    if (scrollToBottomBtn) {
      scrollToBottomBtn.classList.toggle('visible', userScrolledUp && isGenerating);
    }
  });

  if (scrollToBottomBtn) {
    scrollToBottomBtn.addEventListener('click', () => {
      userScrolledUp = false;
      scrollToBottom();
      scrollToBottomBtn.classList.remove('visible');
    });
  }

  // ── Auto-resize textarea ───────────────────────────────
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + 'px';
    updateCmdPopover();
  });

  // ── Escape key: close popovers / stop generation ──────
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (cmdPopoverOpen) {
      closeCmdPopover();
      return;
    }
    if (sessionPopoverOpen) {
      closeSessionPopover();
      return;
    }
    if (popoverOpen) {
      modelPopover.classList.remove('open');
      popoverOpen = false;
      return;
    }
    if (attachMenuOpen) {
      attachMenuOpen = false;
      attachMenu.classList.remove('open');
      return;
    }
    if (isGenerating) {
      vscode.postMessage({ type: 'stopGeneration' });
    }
  });

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
    if (cmdPopoverOpen) closeCmdPopover();
    if (sessionPopoverOpen) closeSessionPopover();
  });

  function renderChips() {
    contextChips.innerHTML = '';
    attachedContexts.forEach((ctx, idx) => {
      const chip = document.createElement('div');
      chip.className = 'context-chip';
      chip.innerHTML =
        `<span class="chip-icon">📎</span>` +
        `<span class="chip-name" title="${escapeHtml(ctx.name)}">${escapeHtml(ctx.name)}</span>` +
        `<button class="chip-remove" data-idx="${idx}" title="Remove">×</button>`;
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
    closeCmdPopover();
    inputEl.value = '';
    inputEl.style.height = 'auto';

    // /clear runs locally — same path as the clear button
    if (text === '/clear') {
      messagesEl.innerHTML = '';
      messagesEl.appendChild(emptyState);
      emptyState.style.display = 'flex';
      vscode.postMessage({ type: 'clearHistory' });
      return;
    }

    hideEmpty();
    const contexts = attachedContexts.length ? [...attachedContexts] : undefined;
    attachedContexts = [];
    renderChips();
    vscode.postMessage({ type: 'sendMessage', text, contexts });
  }

  sendBtn.addEventListener('click', sendMessage);
  inputEl.addEventListener('keydown', (e) => {
    if (cmdPopoverOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdSelected = (cmdSelected + 1) % cmdItems.length; renderCmdPopover(); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); cmdSelected = (cmdSelected - 1 + cmdItems.length) % cmdItems.length; renderCmdPopover(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyCmdSelection(cmdSelected); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));

  clearBtn.addEventListener('click', () => {
    if (isGenerating) return; // Guard: don't clear while generating
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
      header.textContent = '✓ Installed models';
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

    if (capabilities.canListAvailable && availableModels.length > 0) {
      const header = document.createElement('div');
      header.className = 'popover-section-header';
      header.textContent = '⬇ Available to download';
      modelPopover.appendChild(header);

      availableModels.forEach((m) => {
        const opt = document.createElement('div');
        opt.className = 'model-option available';
        const job = pulls[m];
        if (job) {
          const pct = typeof job.percent === 'number' ? ` ${job.percent}%` : '';
          opt.innerHTML = `<span class="model-dot available-dot"></span><span>${m}</span>` +
            `<span class="pull-status">${escapeHtml(job.status)}${pct}</span>` +
            `<button class="pull-btn cancel" title="Cancel">✕</button>`;
          opt.querySelector('.pull-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'cancelPull', model: m });
          });
        } else {
          opt.innerHTML = `<span class="model-dot available-dot"></span><span>${m}</span><button class="pull-btn" title="Download ${m}">Download</button>`;
          opt.querySelector('.pull-btn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            vscode.postMessage({ type: 'pullModel', model: m });
          });
        }
        modelPopover.appendChild(opt);
      });
    }

    if (installedModels.length === 0 && (!capabilities.canListAvailable || availableModels.length === 0)) {
      const empty = document.createElement('div');
      empty.className = 'popover-section-header';
      empty.textContent = serverState === 'ready' ? 'No models' : 'Server not connected';
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
  // ── Session controls ──────────────────────────────────
  sessionsBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleSessionPopover(); });
  newChatBtn.addEventListener('click', () => { vscode.postMessage({ type: 'newSession' }); closeSessionPopover(); });
  sessionPopover.addEventListener('click', (e) => e.stopPropagation());

  // Setup wizard actions are delegated from rendered buttons (see renderSetup).
  setupView.addEventListener('click', (e) => {
    const btn = /** @type {HTMLElement} */ (e.target).closest('[data-setup-action]');
    if (!btn) return;
    const action = /** @type {HTMLElement} */ (btn).dataset.setupAction;
    const value = /** @type {HTMLElement} */ (btn).dataset.value;
    switch (action) {
      case 'selectProvider': vscode.postMessage({ type: 'selectProviderPreset', preset: value }); break;
      case 'install':        vscode.postMessage({ type: 'installServer' }); break;
      case 'start':          vscode.postMessage({ type: 'startOllama' }); break;
      case 'retry':          vscode.postMessage({ type: 'refreshModels' }); break;
      case 'detect':         vscode.postMessage({ type: 'detectServers' }); break;
      case 'pull':           vscode.postMessage({ type: 'pullModel', model: value }); break;
      case 'cancelPull':     vscode.postMessage({ type: 'cancelPull', model: value }); break;
      case 'openSettings':   vscode.postMessage({ type: 'openSettings' }); break;
    }
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
        applyFeatures(msg.features);
        setAgentMode(msg.agentMode);
        slashCommands = msg.slashCommands ?? [];
        refreshBtn.textContent = '⟳';
        refreshBtn.disabled = false;
        break;
      case 'backendState':
        installedModels = msg.installedModels ?? [];
        availableModels = msg.availableModels ?? [];
        currentModel = msg.currentModel ?? '';
        modelBadge.textContent = currentModel || '…';
        capabilities = msg.capabilities ?? capabilities;
        serverState = msg.serverState ?? 'unknown';
        pulls = msg.pulls ?? {};
        recommendedModel = msg.recommendedModel ?? recommendedModel;
        applyBackendState();
        if (popoverOpen) renderPopover();
        break;
      case 'pullDone':
        if (!msg.ok && msg.error && serverState !== 'ready') renderSetup();
        if (!msg.ok && msg.error && serverState === 'ready') appendError('Download failed: ' + msg.error);
        break;
      case 'detectedServers':
        detectedServers = msg.servers ?? [];
        if (serverState !== 'ready') renderSetup();
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
      case 'modelWarmupFailed':
        modelBadge.textContent = truncateModel(msg.model);
        modelBadge.disabled = false;
        modelBadge.classList.remove('loading');
        appendError(`Could not load model "${msg.model}": ${msg.message}`);
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
        scheduleChunk(msg.text);
        break;
      case 'toolCall':
        flushPendingChunks();
        removeThinkingIndicator();
        appendToolCard(msg.tool, msg.callId, msg.requiresApproval);
        break;
      case 'toolResult':
        finalizeToolCard(msg.result, msg.callId);
        break;
      case 'toolApprovalResolved':
        resolveToolApproval(msg.callId, msg.approved);
        break;
      case 'notice':
        flushPendingChunks();
        appendNotice(msg.text);
        break;
      case 'checkpointAvailable':
        showCheckpointBar(msg.checkpointId, msg.files);
        break;
      case 'checkpointRestored':
        markCheckpointRestored(msg.failed);
        break;
      case 'agentThinking':
        flushPendingChunks();
        showThinkingIndicator(msg.iteration, msg.maxIterations);
        break;
      case 'endAssistant':
        flushPendingChunks();
        removeThinkingIndicator();
        finalizeAssistantBubble();
        break;
      case 'error':
        flushPendingChunks();
        removeThinkingIndicator();
        appendError(msg.text);
        break;
      case 'restoreSession':
        restoreSession(msg.entries);
        break;
      case 'sessionList':
        sessions = msg.sessions ?? [];
        activeSessionId = msg.activeId ?? '';
        if (sessionPopoverOpen) renderSessionPopover();
        break;
      case 'contextAdded':
        attachedContexts.push({ name: msg.name, content: msg.content, lang: msg.lang });
        renderChips();
        break;
      case 'contextTrimmed':
        appendNotice(`Conversation is long — ${msg.count} older message${msg.count > 1 ? 's' : ''} trimmed from the model context.`);
        break;
      case 'fileList': {
        // Show only if the input still has an active #query
        if (!FILE_REF_RE.test(inputEl.value)) break;
        const files = msg.files ?? [];
        if (!files.length) { closeCmdPopover(); break; }
        cmdMode = 'file';
        openCmdPopover(files.map((f) => ({ name: f, description: '' })));
        break;
      }
      case 'contextError':
        vscode.postMessage({ type: 'showError' }); // fallback
        appendError(msg.message);
        break;
    }
  });

  // ── State helpers ─────────────────────────────────────
  function truncateModel(name) { return name; } // CSS handles ellipsis

  /** @type {Array<{label:string,url:string,protocol:string}>} */
  let detectedServers = [];

  const PROVIDER_CARDS = [
    { id: 'ollama', name: 'Ollama', desc: 'Recommended — manages model downloads for you', badge: 'Recommended' },
    { id: 'lmstudio', name: 'LM Studio', desc: 'OpenAI-compatible server on :1234' },
    { id: 'jan', name: 'Jan', desc: 'OpenAI-compatible server on :1337' },
    { id: 'llamacpp', name: 'llama.cpp', desc: 'llama-server on :8080' },
  ];

  /** Show the chat surface or the setup wizard based on backend state. */
  function applyBackendState() {
    const ready = serverState === 'ready';
    setupView.style.display = ready ? 'none' : 'flex';
    messagesWrapper.style.display = ready ? 'flex' : 'none';
    inputArea.style.display = ready ? 'flex' : 'none';
    pillBar.style.display = ready ? 'flex' : 'none';
    // Stop-server button only makes sense for backends we can control
    stopOllamaBtn.style.display = capabilities.canStartStopServer ? '' : 'none';
    if (!ready) renderSetup();
  }

  function renderSetup() {
    const h = [];
    h.push(`<div class="setup-inner">`);
    h.push(`<div class="setup-logo">✦</div>`);

    if (serverState === 'not-installed') {
      h.push(`<div class="setup-title">Set up your local AI</div>`);
      h.push(`<div class="setup-sub">Gemma Agent runs entirely on your machine. Pick a local AI server:</div>`);
      h.push(`<div class="provider-cards">`);
      for (const c of PROVIDER_CARDS) {
        h.push(
          `<button class="provider-card" data-setup-action="selectProvider" data-value="${c.id}">` +
          `<span class="pc-name">${c.name}${c.badge ? `<span class="pc-badge">${c.badge}</span>` : ''}</span>` +
          `<span class="pc-desc">${escapeHtml(c.desc)}</span></button>`
        );
      }
      h.push(`</div>`);
      h.push(`<button class="setup-btn primary" data-setup-action="install">⬇ Install Ollama</button>`);
      h.push(`<button class="setup-btn ghost" data-setup-action="detect">🔍 Detect running servers</button>`);
      if (detectedServers.length) {
        h.push(`<div class="setup-detected">Found: ${detectedServers.map((s) => `<button class="detected-server" data-setup-action="selectProvider" data-value="${providerIdForUrl(s)}">${escapeHtml(s.label)}</button>`).join(' ')}</div>`);
      }
      h.push(`<button class="setup-link" data-setup-action="openSettings">Use a custom URL…</button>`);
    } else if (serverState === 'not-running') {
      h.push(`<div class="setup-title">Server not running</div>`);
      if (capabilities.canStartStopServer) {
        h.push(`<div class="setup-sub">Ollama is installed but not running.</div>`);
        h.push(`<button class="setup-btn primary" data-setup-action="start">▶ Start Ollama</button>`);
      } else {
        h.push(`<div class="setup-sub">Start your local AI server, then retry. Expecting it at the configured URL.</div>`);
        h.push(`<button class="setup-btn primary" data-setup-action="retry">↻ Retry connection</button>`);
      }
      h.push(`<button class="setup-link" data-setup-action="openSettings">Change server settings…</button>`);
    } else if (serverState === 'no-models') {
      h.push(`<div class="setup-title">Almost ready</div>`);
      if (capabilities.canPull) {
        const job = pulls[recommendedModel];
        h.push(`<div class="setup-sub">Download a model to get started:</div>`);
        h.push(`<div class="model-card">`);
        h.push(`<span class="mc-name">${recommendedModel}</span>`);
        if (job) {
          const pct = typeof job.percent === 'number' ? job.percent : 0;
          h.push(`<div class="mc-progress"><div class="mc-bar" style="width:${pct}%"></div></div>`);
          h.push(`<span class="mc-status">${escapeHtml(job.status)}${typeof job.percent === 'number' ? ` ${job.percent}%` : ''}</span>`);
          h.push(`<button class="setup-btn ghost" data-setup-action="cancelPull" data-value="${recommendedModel}">Cancel</button>`);
        } else {
          h.push(`<button class="setup-btn primary" data-setup-action="pull" data-value="${recommendedModel}">⬇ Download ${recommendedModel}</button>`);
        }
        h.push(`</div>`);
      } else {
        h.push(`<div class="setup-sub">Your server is running but has no model loaded. Load one in your server's UI, then retry.</div>`);
        h.push(`<button class="setup-btn primary" data-setup-action="retry">↻ Retry</button>`);
      }
    } else {
      h.push(`<div class="setup-title">Connecting…</div>`);
      h.push(`<div class="setup-sub">Checking your local AI server.</div>`);
    }

    h.push(`</div>`);
    setupView.innerHTML = h.join('');
  }

  function providerIdForUrl(s) {
    if (s.protocol === 'ollama') return 'ollama';
    if (s.url.includes('1234')) return 'lmstudio';
    if (s.url.includes('1337')) return 'jan';
    if (s.url.includes('8080')) return 'llamacpp';
    return 'ollama';
  }

  function setAgentMode(enabled) {
    agentPill.classList.toggle('active', enabled);
    agentPill.classList.toggle('inactive', !enabled);
    modeLabel.textContent = enabled ? '⚡ Agent' : 'Chat';
    modeLabel.className = 'modeLabel' + (enabled ? ' agent' : '');
    inputEl.placeholder = enabled
      ? 'Agent: create files, edit, run commands… (Enter)'
      : 'Message… (Enter to send, Shift+Enter for newline)';
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
    clearBtn.disabled = disabled;
    clearBtn.style.opacity = disabled ? '0.4' : '';
    clearBtn.style.cursor = disabled ? 'default' : '';
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function scrollToBottomIfSticky() {
    if (!userScrolledUp) scrollToBottom();
  }

  // ── RAF-batched chunk rendering ────────────────────────
  function scheduleChunk(text) {
    pendingChunks += text;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        flushPendingChunks();
      });
    }
  }

  function flushPendingChunks() {
    if (!pendingChunks || !assistantBubble) { pendingChunks = ''; return; }
    rawBuffer += pendingChunks;
    pendingChunks = '';
    assistantBubble.innerHTML = renderMarkdown(rawBuffer);
    scrollToBottomIfSticky();
  }

  // ── Agent thinking indicator ──────────────────────────
  function showThinkingIndicator(iteration, maxIterations) {
    removeThinkingIndicator();
    const div = document.createElement('div');
    div.className = 'agent-thinking';
    div.innerHTML =
      `<span class="thinking-spinner">⟳</span>` +
      `<span class="thinking-label">Thinking… <span class="thinking-step">step ${iteration}/${maxIterations}</span></span>`;
    messagesEl.appendChild(div);
    thinkingIndicator = div;
    scrollToBottomIfSticky();
  }

  function removeThinkingIndicator() {
    if (thinkingIndicator) {
      thinkingIndicator.remove();
      thinkingIndicator = null;
    }
  }

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
    userScrolledUp = false;
  }

  function startAssistantBubble() {
    isGenerating = true;
    rawBuffer = '';
    pendingChunks = '';
    rafPending = false;
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
    userScrolledUp = false;
  }

  function finalizeAssistantBubble() {
    isGenerating = false;
    setInputDisabled(false);
    if (scrollToBottomBtn) scrollToBottomBtn.classList.remove('visible');
    // Run ended while a tool was awaiting approval (e.g. Stop pressed)
    document.querySelectorAll('.tool-card.awaiting').forEach((card) => {
      card.querySelector('.tool-approval')?.remove();
      card.classList.remove('awaiting');
      const badge = card.querySelector('.tool-status-badge');
      if (badge) badge.textContent = 'canceled';
    });
    if (assistantBubble) {
      if (!rawBuffer.trim()) {
        // Agent only did tool calls — remove empty bubble
        assistantBubble.closest('.message')?.remove();
      } else {
        addCodeBlockButtons(assistantBubble);
        addRegenerateButton(assistantBubble.closest('.message'));
      }
    }
    assistantBubble = null;
    rawBuffer = '';
    inputEl.focus();
  }

  function appendNotice(text) {
    hideEmpty();
    const div = document.createElement('div');
    div.className = 'chat-notice';
    div.textContent = text;
    // While streaming, place the notice above the live assistant bubble
    const wrap = assistantBubble?.closest('.message');
    if (wrap) messagesEl.insertBefore(div, wrap);
    else messagesEl.appendChild(div);
    scrollToBottomIfSticky();
  }

  function appendError(text) {
    isGenerating = false;
    rawBuffer = '';
    pendingChunks = '';
    rafPending = false;
    setInputDisabled(false);
    if (scrollToBottomBtn) scrollToBottomBtn.classList.remove('visible');
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

  // ── Regenerate last response ──────────────────────────
  function addRegenerateButton(msgWrap) {
    if (!msgWrap) return;
    const btn = document.createElement('button');
    btn.className = 'regen-btn';
    btn.title = 'Regenerate response';
    btn.textContent = '↺';
    btn.addEventListener('click', () => {
      if (isGenerating) return;
      // Find and re-send the last user message
      const allMessages = messagesEl.querySelectorAll('.message.user');
      const lastUser = allMessages[allMessages.length - 1];
      const lastText = lastUser?.querySelector('.bubble')?.textContent ?? '';
      if (!lastText) return;
      // Remove the assistant message and the user bubble —
      // the extension re-posts the user turn, avoiding duplicates
      msgWrap.remove();
      lastUser.remove();
      vscode.postMessage({ type: 'regenerate', text: lastText });
    });
    msgWrap.appendChild(btn);
  }

  // ── Tool cards ────────────────────────────────────────
  const TOOL_META = {
    create_file:     { emoji: '📄', label: 'Create file' },
    edit_file:       { emoji: '✏️', label: 'Edit file' },
    read_file:       { emoji: '📖', label: 'Read file' },
    run_command:     { emoji: '⚡', label: 'Run command' },
    list_files:      { emoji: '📁', label: 'List directory' },
    search_files:    { emoji: '🔍', label: 'Search files' },
    get_diagnostics: { emoji: '🩺', label: 'Get diagnostics' },
  };

  /** @type {Map<string, HTMLDivElement>} */
  const toolCards = new Map();

  function appendToolCard(tool, callId, requiresApproval) {
    const meta = TOOL_META[tool.tool] ?? { emoji: '⚙', label: tool.tool };
    const arg = tool.path ?? tool.command ?? tool.query ?? '';

    const card = document.createElement('div');
    card.className = 'tool-card ' + (requiresApproval ? 'awaiting' : 'running');
    if (callId) {
      card.dataset.callId = callId;
      toolCards.set(callId, card);
    }
    card.innerHTML = `
      <div class="tool-card-left">
        <span class="tool-emoji">${meta.emoji}</span>
        <span class="tool-name">${meta.label}</span>
      </div>
      <span class="tool-arg" title="${escapeHtml(arg)}">${escapeHtml(arg)}</span>
      <span class="tool-status-badge">${requiresApproval ? 'needs approval' : 'running…'}</span>`;

    if (requiresApproval) {
      const actions = document.createElement('div');
      actions.className = 'tool-approval';
      actions.innerHTML =
        `<button class="approval-btn approve" data-decision="approve">✓ Approve</button>` +
        `<button class="approval-btn deny" data-decision="deny">✗ Deny</button>` +
        `<button class="approval-btn always" data-decision="always">Always allow</button>`;
      actions.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'toolApproval', callId, decision: /** @type {HTMLButtonElement} */ (btn).dataset.decision });
        });
      });
      card.appendChild(actions);
    }

    messagesEl.appendChild(card);
    lastToolCard = card;
    scrollToBottomIfSticky();
  }

  function resolveToolApproval(callId, approved) {
    const card = toolCards.get(callId) || lastToolCard;
    if (!card) return;
    card.querySelector('.tool-approval')?.remove();
    card.classList.remove('awaiting');
    const badge = card.querySelector('.tool-status-badge');
    if (approved) {
      card.classList.add('running');
      if (badge) badge.textContent = 'running…';
    } else if (badge) {
      badge.textContent = 'denied'; // the DENIED tool_result finalizes the card
    }
  }

  function finalizeToolCard(result, callId) {
    const card = (callId && toolCards.get(callId)) || lastToolCard;
    if (!card) return;
    if (callId) toolCards.delete(callId);
    card.querySelector('.tool-approval')?.remove();
    card.classList.remove('running', 'awaiting');
    card.classList.add(result.ok ? 'success' : 'failure');
    const badge = card.querySelector('.tool-status-badge');
    if (badge) badge.textContent = result.ok ? '✓ Done' : '✗ Error';

    if (result.output && result.output.length > 15) {
      const details = document.createElement('details');
      details.className = 'tool-output-toggle';
      const pre = document.createElement('pre');
      pre.className = 'tool-output-pre';
      pre.textContent = result.output;
      details.innerHTML = '<summary>Show output</summary>';
      details.appendChild(pre);
      card.appendChild(details);
    }
    if (card === lastToolCard) lastToolCard = null;
    scrollToBottomIfSticky();
  }

  // ── Checkpoint (undo agent edits) bar ─────────────────
  /** @type {HTMLDivElement|null} */
  let checkpointBar = null;

  function showCheckpointBar(checkpointId, files) {
    // Only the latest checkpoint is restorable — retire the previous bar
    if (checkpointBar) {
      const old = checkpointBar.querySelector('button');
      if (old && !old.disabled) { old.disabled = true; old.textContent = 'Superseded'; }
    }
    const bar = document.createElement('div');
    bar.className = 'checkpoint-bar';
    const btn = document.createElement('button');
    btn.className = 'undo-btn';
    btn.textContent = `↩ Undo edits (${files.length} file${files.length > 1 ? 's' : ''})`;
    btn.title = files.join('\n');
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Restoring…';
      vscode.postMessage({ type: 'undoCheckpoint', checkpointId });
    });
    bar.appendChild(btn);
    messagesEl.appendChild(bar);
    checkpointBar = bar;
    scrollToBottomIfSticky();
  }

  function markCheckpointRestored(failed) {
    if (!checkpointBar) return;
    const btn = checkpointBar.querySelector('button');
    if (btn) {
      btn.disabled = true;
      btn.textContent = failed && failed.length ? '⚠ Partially restored' : '✓ Restored';
    }
    checkpointBar = null;
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
          `<button class="copy-btn">Copy</button></div>` +
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

  // ── Session restore ───────────────────────────────────
  function restoreSession(entries) {
    // Clear the message list and any transient run state
    isGenerating = false;
    setInputDisabled(false);
    assistantBubble = null;
    rawBuffer = '';
    messagesEl.innerHTML = '';
    messagesEl.appendChild(emptyState);
    emptyState.style.display = 'flex';
    if (!entries || entries.length === 0) return;
    hideEmpty();
    entries.forEach((e) => {
      if (e.kind === 'user') {
        appendUserMessage(e.content);
      } else if (e.kind === 'assistant' && e.content) {
        const wrap = document.createElement('div');
        wrap.className = 'message assistant';
        const header = document.createElement('div');
        header.className = 'msg-header';
        header.innerHTML = '<div class="msg-avatar">G</div><span class="msg-name">Gemma</span>';
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.innerHTML = renderMarkdown(e.content);
        wrap.appendChild(header);
        wrap.appendChild(bubble);
        messagesEl.appendChild(wrap);
        addCodeBlockButtons(bubble);
      } else if (e.kind === 'tool') {
        renderFinalizedToolCard(e);
      } else if (e.kind === 'notice') {
        appendNotice(e.text);
      }
    });
    scrollToBottom();
  }

  /** Render a persisted tool entry as a finalized card (no approval buttons). */
  function renderFinalizedToolCard(e) {
    const meta = TOOL_META[e.tool] ?? { emoji: '⚙', label: e.tool };
    const card = document.createElement('div');
    card.className = 'tool-card ' + (e.ok ? 'success' : 'failure');
    card.innerHTML = `
      <div class="tool-card-left">
        <span class="tool-emoji">${meta.emoji}</span>
        <span class="tool-name">${meta.label}</span>
      </div>
      <span class="tool-arg" title="${escapeHtml(e.arg)}">${escapeHtml(e.arg)}</span>
      <span class="tool-status-badge">${e.ok ? '✓ Done' : '✗ Error'}</span>`;
    if (e.output && e.output.length > 15) {
      const details = document.createElement('details');
      details.className = 'tool-output-toggle';
      const pre = document.createElement('pre');
      pre.className = 'tool-output-pre';
      pre.textContent = e.output;
      details.innerHTML = '<summary>Show output</summary>';
      details.appendChild(pre);
      card.appendChild(details);
    }
    messagesEl.appendChild(card);
  }

  // ── Session popover ───────────────────────────────────
  function toggleSessionPopover() {
    sessionPopoverOpen = !sessionPopoverOpen;
    if (sessionPopoverOpen) {
      renderSessionPopover();
      sessionPopover.classList.add('open');
    } else {
      sessionPopover.classList.remove('open');
    }
  }

  function closeSessionPopover() {
    sessionPopoverOpen = false;
    sessionPopover.classList.remove('open');
  }

  function renderSessionPopover() {
    sessionPopover.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'popover-section-header';
    header.textContent = 'Chat sessions';
    sessionPopover.appendChild(header);

    sessions.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'session-row' + (s.id === activeSessionId ? ' active' : '');
      row.innerHTML =
        `<span class="session-title" title="${escapeHtml(s.title)}">${escapeHtml(s.title)}</span>` +
        `<button class="session-act rename" title="Rename">✎</button>` +
        `<button class="session-act delete" title="Delete">🗑</button>`;
      row.querySelector('.session-title')?.addEventListener('click', () => {
        if (s.id !== activeSessionId) vscode.postMessage({ type: 'switchSession', id: s.id });
        closeSessionPopover();
      });
      row.querySelector('.rename')?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        startRename(row, s);
      });
      let confirmDelete = false;
      const delBtn = row.querySelector('.delete');
      delBtn?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!confirmDelete) {
          confirmDelete = true;
          delBtn.textContent = '✓?';
          setTimeout(() => { confirmDelete = false; delBtn.textContent = '🗑'; }, 2500);
          return;
        }
        vscode.postMessage({ type: 'deleteSession', id: s.id });
      });
      sessionPopover.appendChild(row);
    });

    const positionRect = sessionsBtn.getBoundingClientRect();
    sessionPopover.style.top = (positionRect.bottom + 4) + 'px';
    sessionPopover.style.right = '8px';
  }

  function startRename(row, s) {
    const titleEl = row.querySelector('.session-title');
    if (!titleEl) return;
    const input = document.createElement('input');
    input.className = 'session-rename-input';
    input.value = s.title;
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      const v = input.value.trim();
      if (v && v !== s.title) vscode.postMessage({ type: 'renameSession', id: s.id, title: v });
      else renderSessionPopover();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      else if (ev.key === 'Escape') { ev.preventDefault(); renderSessionPopover(); }
    });
    input.addEventListener('blur', commit);
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
            setTimeout(() => { copyBtn.innerHTML = 'Copy'; copyBtn.classList.remove('copied'); }, 1500);
          });
        });
      }
      const insertBtn = document.createElement('button');
      insertBtn.className = 'insert-btn';
      insertBtn.textContent = '↩ Insert into editor';
      insertBtn.addEventListener('click', () => vscode.postMessage({ type: 'insertCode', code }));
      block.after(insertBtn);
    });
  }
})();
