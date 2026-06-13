import * as vscode from 'vscode';
import { combineInstructions } from './instructionsCore';

export { combineInstructions };

const RULES_RELATIVE_PATH = '.gemma/rules.md';

// ── Live cache (vscode-bound) ───────────────────────────────
let cachedRulesFile = '';

function readSetting(): string {
  return vscode.workspace.getConfiguration('gemmaAgent').get<string>('customInstructions', '');
}

/** The instruction suffix to append to a system prompt at request time. */
export function getInstructionSuffix(): string {
  return combineInstructions(readSetting(), cachedRulesFile);
}

async function loadRulesFile(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) { cachedRulesFile = ''; return; }
  try {
    const uri = vscode.Uri.joinPath(root, RULES_RELATIVE_PATH);
    const bytes = await vscode.workspace.fs.readFile(uri);
    cachedRulesFile = Buffer.from(bytes).toString('utf-8');
  } catch {
    cachedRulesFile = '';
  }
}

export function registerInstructions(context: vscode.ExtensionContext): void {
  void loadRulesFile();
  const watcher = vscode.workspace.createFileSystemWatcher(`**/${RULES_RELATIVE_PATH}`);
  watcher.onDidCreate(() => void loadRulesFile());
  watcher.onDidChange(() => void loadRulesFile());
  watcher.onDidDelete(() => { cachedRulesFile = ''; });
  context.subscriptions.push(watcher);
}
