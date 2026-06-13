# Agent mode

Toggle **⚡ Agent** in the chat to let Gemma work autonomously: it can read,
create and edit files, run commands, search the workspace and check diagnostics.

You stay in control:

- **Approvals** — shell commands (and optionally file writes) wait for your OK.
  Preview file changes with **View diff** before approving.
- **Review** — after a run, review every changed file and Keep or Revert each,
  or Undo all at once.
- **Auto-verify** — after edits, Gemma runs diagnostics and fixes its own errors.

Configure approval scope with `gemmaAgent.agentRequireApproval`.
