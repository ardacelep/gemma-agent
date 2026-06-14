# Gemma Agent

Local AI coding assistant for VS Code — chat, inline completion, in-place editing, agentic file editing, semantic workspace search and commit message generation. **100% offline**: your code never leaves your machine.

Runs on **any local model server**: [Ollama](https://ollama.com) (recommended) or any OpenAI-compatible server — **LM Studio**, **Jan**, **llama.cpp** `llama-server`, **vLLM**, **LocalAI**. Lives in its own sidebar, like Copilot/Cursor.

## Features

### 🚀 Guided setup
- A setup wizard detects whether your server is installed, running, and has a model — and walks you through each step (install, start, download a model with a progress bar). No manual fiddling.
- Provider cards switch between Ollama and OpenAI-compatible servers; the UI adapts to each backend's capabilities.

### 💬 Chat
- Streaming chat in the sidebar with syntax highlighting, copy / insert-into-editor buttons
- **Multiple sessions** — name, switch, rename and delete conversations; everything (including tool cards) persists per workspace
- **Slash commands** — type `/` for `/explain`, `/fix`, `/tests`, `/docs`, `/clear`; your selection or active file is attached automatically
- **`#file` / `#terminal` references** — type `#` to attach a workspace file or the last terminal command's output
- **`@workspace`** — semantic search over a local embedding index of your codebase (opt-in)
- Automatic context-window management: long conversations are trimmed to fit the model instead of silently breaking it
- Custom instructions via a setting or a `.gemma/rules.md` file

### ⚡ Agent mode
Let the model create files, edit code and run commands in a tool-call loop:
- **Approval flow** — shell commands (and optionally file writes) wait for your Approve / Deny / Always-allow; **View diff** previews a change before you approve it
- **Review changes** — after a run, review every changed file and Keep or Revert each, or Undo all at once
- **Auto-verify** — after edits the agent runs diagnostics and fixes its own errors before finishing
- Live tool cards with status, collapsible output, and a step indicator

### ✏️ Inline edit
Select code (or just place the cursor) and press `Cmd+Shift+I` / `Ctrl+Shift+I`:
- The rewrite **streams directly into your editor**, highlighted as it arrives
- Accept with `Cmd+Enter` / reject with `Esc` (CodeLens buttons too)
- The whole edit is a single undo step

### 👻 Inline completion
- Ghost-text completions with debouncing and careful post-processing
- Accept word-by-word (`Cmd+→` / `Ctrl+→`), whole suggestion (`Tab`), or cycle alternatives (`Alt+]` / `Alt+[`)
- Per-language enable/disable (`gemmaAgent.completionLanguages`)

### 🛠 Extras
- **Commit messages** — ✨ button in the Source Control title bar writes a conventional-commit message from your staged diff
- **"✨ Fix with Gemma"** quick-fix on any error squiggle (no selection needed)
- Right-click code actions: Explain, Refactor, Fix, Generate Tests
- Terminal helpers: explain/fix the last command (captured automatically via shell integration), or run a selection
- Commit messages — ✨ button in the Source Control title bar from your staged diff
- Server lifecycle from the status bar and sidebar (start, stop, pull models with progress, model picker)

## Requirements

- A local model server. Easiest: [Ollama](https://ollama.com/download) — the extension can install-guide and pull models for you.
- Or any OpenAI-compatible server (LM Studio, Jan, llama.cpp `llama-server`, vLLM, LocalAI): set `gemmaAgent.apiProtocol` to `openai-compatible` and point `gemmaAgent.ollamaUrl` at it.
- A model, e.g. `gemma4:e4b`. For `@workspace`, also pull an embedding model (`nomic-embed-text`).

## Choosing models (this matters as much as the code)

Gemma Agent routes each task to a **role**, so you can run a different model per job. Set these in Settings; empty roles fall back to the main model.

| Role | Setting | Good picks (mid‑2026) | Why |
|---|---|---|---|
| Chat | `gemmaAgent.model` | `gemma4:e4b`, `qwen3:8b`, `gemma3:12b` | General Q&A, explanations |
| Agent | `gemmaAgent.agentModel` | `qwen3-coder:30b`, `devstral:24b`, `qwen2.5-coder:7b` | Reliable tool‑calling + multi‑file edits |
| Completion | `gemmaAgent.completionModel` | `qwen2.5-coder:1.5b-base`, `:3b-base`, `codegemma:2b` | **Real FIM** ghost text — small *and* high‑quality |
| Embedding | `gemmaAgent.embeddingModel` | `nomic-embed-text`, `embeddinggemma` | `@workspace` semantic search |

Notes:
- **Ghost text quality** comes from a code model with fill‑in‑the‑middle, not from size — `qwen2.5-coder:1.5b-base` is tiny *and* excellent. Use the `-base` variant for FIM. Detection is automatic (`gemmaAgent.completionFim: auto`).
- **Agent reliability** scales with the model. A strong tool‑caller plus structured‑output (`gemmaAgent.agentStructuredOutput`, on by default where supported) makes agent mode far more dependable than a small general model.
- Everything installs the same way: `ollama pull qwen2.5-coder:1.5b-base`. If a role's model isn't installed, Gemma Agent offers to pull it and falls back to the main model meanwhile.
- The starting recommendations live in `src/llm/modelCatalog.ts` — **keep it current**; local models move fast (e.g. Qwen3‑Coder‑Next, DeepSeek V4, MiniMax M3, Kimi K2, Gemma 4 12B). You can run *any* model regardless of the catalog.
- **Faster generation:** for a big speedup, run a server that supports **speculative decoding** with a small draft model — LM Studio (≥0.3.10) or `llama-server --model-draft`. Ollama doesn't expose this yet. `gemmaAgent.keepAlive` (default 30m) keeps the model warm between turns.

## Keyboard shortcuts

| Action | macOS | Windows/Linux |
|---|---|---|
| Open chat | `⌘⇧G` | `Ctrl+Shift+G` |
| Explain selection | `⌘⌥E` | `Ctrl+Alt+E` |
| Inline edit (selection or cursor) | `⌘⇧I` | `Ctrl+Shift+I` |
| Accept inline edit | `⌘⏎` | `Ctrl+Enter` |
| Reject inline edit | `Esc` | `Esc` |
| Accept completion | `Tab` | `Tab` |
| Accept next word of completion | `⌘→` | `Ctrl+→` |
| Cycle completion alternatives | `⌥]` / `⌥[` | `Alt+]` / `Alt+[` |
| Stop generation (chat) | `Esc` | `Esc` |

## Key settings

| Setting | Default | Description |
|---|---|---|
| `gemmaAgent.apiProtocol` | `ollama` | `ollama` or `openai-compatible` |
| `gemmaAgent.model` | `gemma4:e4b` | Main chat model |
| `gemmaAgent.agentModel` | `""` | Model for ⚡ Agent mode; empty = main model |
| `gemmaAgent.completionModel` | `""` | Model for inline completion; empty = main model |
| `gemmaAgent.agentStructuredOutput` | `true` | Schema-constrain agent tool calls for reliability |
| `gemmaAgent.completionFim` | `auto` | Real fill-in-the-middle when the model supports it |
| `gemmaAgent.keepAlive` | `30m` | Keep the model warm in RAM between requests |
| `gemmaAgent.numCtx` | `8192` | Context window size (more = more RAM) |
| `gemmaAgent.agentRequireApproval` | `commands` | Which agent tools need approval (`commands` / `commandsAndWrites` / `never`) |
| `gemmaAgent.agentAutoVerify` | `true` | Run diagnostics + self-fix after agent edits |
| `gemmaAgent.workspaceIndexEnabled` | `false` | Enable `@workspace` semantic search |
| `gemmaAgent.autoWorkspaceContext` | `false` | Auto-attach relevant code to chat (needs index) |

See the full list in Settings under **Gemma Agent**.

## Privacy

Everything runs locally through your own model server. No telemetry, no cloud calls, zero runtime dependencies. (OpenAI-compatible servers are assumed keyless/local; no API key is sent.)

## License

MIT
