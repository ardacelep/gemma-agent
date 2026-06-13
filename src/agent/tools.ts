import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';
import { TOOL_NAMES, ToolName, ToolCall } from './toolCallParser';
import { applyEdit } from './editApply';
import { BINARY_EXT } from '../index/chunker';

// Re-export so existing importers (agentLoop, chatProvider) keep working
export { TOOL_NAMES, ToolName, ToolCall };

export interface ToolResult {
  ok: boolean;
  output: string;
}

function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    throw new Error(
      'No open workspace folder. ' +
      'Open a folder with "File → Open Folder" and try again.'
    );
  }
  return root;
}

export function resolveUri(filePath: string): vscode.Uri {
  const root = workspaceRoot();
  const resolved = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(root, filePath);

  // Security: reject paths that escape the workspace root
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Access denied: "${filePath}" is outside the workspace.`);
  }

  return vscode.Uri.file(resolved);
}

export async function executeTool(call: ToolCall, signal?: AbortSignal): Promise<ToolResult> {
  try {
    switch (call.tool) {
      case 'create_file':
        return await createFile(call.path as string, call.content as string);
      case 'edit_file':
        return await editFile(call.path as string, call.search as string, call.replace as string);
      case 'read_file':
        return await readFile(call.path as string);
      case 'run_command':
        return await runCommand(call.command as string, signal);
      case 'list_files':
        return await listFiles((call.path as string) ?? '.');
      case 'search_files':
        return await searchFiles(call.query as string, call.path as string, call.regex === true);
      case 'get_diagnostics':
        return getDiagnostics(call.path as string | undefined);
      default:
        return { ok: false, output: `Unknown tool: ${call.tool}` };
    }
  } catch (err) {
    return { ok: false, output: `Error: ${(err as Error).message}` };
  }
}

async function createFile(filePath: string, content: string): Promise<ToolResult> {
  if (!filePath) return { ok: false, output: 'path not specified' };
  const uri = resolveUri(filePath);

  // Create parent directories if needed
  const parentUri = vscode.Uri.file(path.dirname(uri.fsPath));
  await vscode.workspace.fs.createDirectory(parentUri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content ?? '', 'utf-8'));

  return { ok: true, output: `Created: ${filePath}` };
}

async function editFile(filePath: string, search: string, replace: string): Promise<ToolResult> {
  if (!filePath) return { ok: false, output: 'path not specified' };

  const uri = resolveUri(filePath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const original = Buffer.from(bytes).toString('utf-8');

  const result = applyEdit(original, search, replace);
  if (!result.ok) {
    return { ok: false, output: `${result.error} (in ${filePath})` };
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(result.content!, 'utf-8'));
  return { ok: true, output: `Edited: ${filePath}` };
}

async function readFile(filePath: string): Promise<ToolResult> {
  if (!filePath) return { ok: false, output: 'path not specified' };
  const uri = resolveUri(filePath);

  // Size guard: refuse files larger than 500 KB
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > 500 * 1024) {
    return {
      ok: false,
      output: `File too large (${Math.round(stat.size / 1024)} KB). Maximum is 500 KB.`,
    };
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  const content = Buffer.from(bytes).toString('utf-8');
  const lines = content.split('\n');
  // Cap at 300 lines to avoid flooding context
  const preview = lines.length > 300
    ? lines.slice(0, 300).join('\n') + `\n... (+${lines.length - 300} more lines)`
    : content;
  return { ok: true, output: preview };
}

const COMMAND_TIMEOUT_MS = 30_000;

async function runCommand(command: string, signal?: AbortSignal): Promise<ToolResult> {
  if (!command) return { ok: false, output: 'command not specified' };

  const root = workspaceRoot();
  const platform = os.platform();
  const shell    = platform === 'win32' ? 'cmd'    : '/bin/sh';
  const flag     = platform === 'win32' ? '/c'     : '-c';

  return new Promise((resolve) => {
    const proc = cp.spawn(shell, [flag, command], {
      cwd: root,
      // Inherit PATH so common tools (git, npm, python…) are found
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const kill = () => {
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      killTimer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 2_000);
    };

    const timeout = setTimeout(() => { timedOut = true; kill(); }, COMMAND_TIMEOUT_MS);
    const onAbort = () => { aborted = true; kill(); };
    signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      cleanup();
      let combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      if (combined.length > 4000) combined = combined.slice(0, 4000) + '\n… (output truncated)';
      if (aborted) {
        resolve({ ok: false, output: 'Command aborted by user.' + (combined ? `\nPartial output:\n${combined}` : '') });
        return;
      }
      if (timedOut) {
        resolve({ ok: false, output: `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.` + (combined ? `\nPartial output:\n${combined}` : '') });
        return;
      }
      resolve({
        ok: code === 0,
        output: combined || `(exited with code ${code})`,
      });
    });

    proc.on('error', (err) => {
      cleanup();
      resolve({ ok: false, output: `Failed to run command: ${err.message}` });
    });
  });
}

async function listFiles(dirPath: string): Promise<ToolResult> {
  const uri = resolveUri(dirPath);
  const entries = await vscode.workspace.fs.readDirectory(uri);
  const lines = entries.map(([name, type]) => {
    const icon = type === vscode.FileType.Directory ? '📁' : '📄';
    return `${icon} ${name}`;
  });
  return { ok: true, output: lines.join('\n') || '(empty directory)' };
}


async function searchFiles(query: string, dirPath?: string, useRegex?: boolean): Promise<ToolResult> {
  if (!query) return { ok: false, output: 'search query not specified' };
  const include = dirPath ? `${dirPath}/**` : '**';
  const results = await vscode.workspace.findFiles(include, '{**/node_modules/**,**/.git/**}', 200);

  let note = '';
  let matcher: (line: string) => boolean;
  if (useRegex) {
    try {
      const re = new RegExp(query, 'i');
      matcher = (line) => re.test(line);
    } catch {
      note = `(invalid regex "${query}" — fell back to literal search)\n`;
      const q = query.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(q);
    }
  } else {
    const q = query.toLowerCase();
    matcher = (line) => line.toLowerCase().includes(q);
  }

  const MAX_MATCHES = 100;
  const matches: string[] = [];
  for (const uri of results) {
    if (matches.length >= MAX_MATCHES) break;
    if (BINARY_EXT.test(uri.path)) continue;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf-8');
      const rel = vscode.workspace.asRelativePath(uri);
      const lines = text.split('\n');
      for (let ln = 0; ln < lines.length && matches.length < MAX_MATCHES; ln++) {
        if (matcher(lines[ln])) {
          matches.push(`${rel}:${ln + 1}: ${lines[ln].trim().slice(0, 120)}`);
        }
      }
    } catch { /* skip unreadable files */ }
  }
  return {
    ok: true,
    output: note + (matches.length ? matches.join('\n') : `No results found for "${query}"`),
  };
}

function getDiagnostics(filePath?: string): ToolResult {
  const MAX_LINES = 50;
  const severityNames = ['Error', 'Warning'];

  let entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>;
  if (filePath) {
    const uri = resolveUri(filePath);
    entries = [[uri, vscode.languages.getDiagnostics(uri)]];
  } else {
    entries = [...vscode.languages.getDiagnostics()];
  }

  const lines: string[] = [];
  for (const [uri, diags] of entries) {
    if (lines.length >= MAX_LINES) break;
    const rel = vscode.workspace.asRelativePath(uri);
    for (const d of diags) {
      if (lines.length >= MAX_LINES) break;
      if (d.severity > vscode.DiagnosticSeverity.Warning) continue; // errors + warnings only
      const code = typeof d.code === 'object' && d.code !== null ? d.code.value : d.code;
      lines.push(
        `${rel}:${d.range.start.line + 1}:${d.range.start.character + 1} ` +
        `[${severityNames[d.severity]}] ${d.message}${code !== undefined && code !== '' ? ` (${code})` : ''}`
      );
    }
  }

  return {
    ok: true,
    output: lines.length
      ? lines.join('\n')
      : '(no diagnostics found — language services may still be analyzing recently edited files)',
  };
}
