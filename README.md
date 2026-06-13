# Gemma Agent

Local AI coding assistant for VS Code, powered by [Ollama](https://ollama.com) and Gemma models — chat, inline completion, in-place editing, agentic file editing and commit message generation. **100% offline**: your code never leaves your machine.

## Features

### 💬 Chat
- Streaming chat panel with syntax highlighting, copy / insert-into-editor buttons
- **Persistent history** — conversations survive VS Code restarts (per workspace)
- **Slash commands** — type `/` for `/explain`, `/fix`, `/tests`, `/docs`, `/clear`; your selection or active file is attached automatically
- **`#file` references** — type `#` to search and attach any workspace file as context
- Automatic context-window management: long conversations are trimmed to fit the model instead of silently breaking it

### ⚡ Agent mode
Let the model create files, edit code and run commands in a tool-call loop:
- **Approval flow** — shell commands (and optionally file writes) wait for your Approve / Deny, with a per-session "Always allow"
- **Undo edits** — one click restores every file the agent touched (created files are deleted)
- Live tool cards with status, collapsible output, and a step indicator
- `get_diagnostics` tool lets the agent verify its own edits against compiler/linter errors

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
- Right-click code actions: Explain, Refactor, Fix, Generate Tests
- Terminal helpers: run selection, explain output, fix errors
- Ollama lifecycle management from the status bar and chat panel (start, stop, pull models, model picker with warm-up)

## Requirements

- [Ollama](https://ollama.com/download) installed and running (`ollama serve`)
- A Gemma model pulled, e.g. `ollama pull gemma4:e4b` (the extension can pull models for you)

## Keyboard shortcuts

| Action | macOS | Windows/Linux |
|---|---|---|
| Open chat | `⌘⇧G` | `Ctrl+Shift+G` |
| Explain selection | `⌘⇧E` | `Ctrl+Shift+E` |
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
| `gemmaAgent.model` | `gemma4:e4b` | Model to use |
| `gemmaAgent.numCtx` | `8192` | Context window size sent to Ollama (more = more RAM) |
| `gemmaAgent.agentRequireApproval` | `commands` | Which agent tools need your approval (`commands` / `commandsAndWrites` / `never`) |
| `gemmaAgent.completionLanguages` | `{"*": true, "markdown": false, …}` | Per-language completion toggle |
| `gemmaAgent.completionAlternatives` | `1` | Completion suggestions to generate (1–3; >1 adds latency) |

See the full list in Settings under **Gemma Agent**.

## Privacy

Everything runs locally through your Ollama server. No telemetry, no cloud calls, zero runtime dependencies.

## License

MIT
