import * as vscode from 'vscode';
import * as path from 'path';
import * as cp from 'child_process';
import * as os from 'os';

export type ToolName = 'create_file' | 'edit_file' | 'read_file' | 'run_command' | 'list_files' | 'search_files';

export interface ToolCall {
  tool: ToolName;
  [key: string]: unknown;
}

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

function resolveUri(filePath: string): vscode.Uri {
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

export async function executeTool(call: ToolCall): Promise<ToolResult> {
  try {
    switch (call.tool) {
      case 'create_file':
        return await createFile(call.path as string, call.content as string);
      case 'edit_file':
        return await editFile(call.path as string, call.search as string, call.replace as string);
      case 'read_file':
        return await readFile(call.path as string);
      case 'run_command':
        return await runCommand(call.command as string);
      case 'list_files':
        return await listFiles((call.path as string) ?? '.');
      case 'search_files':
        return await searchFiles(call.query as string, call.path as string);
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
  if (search === undefined) return { ok: false, output: 'search text not specified' };

  const uri = resolveUri(filePath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const original = Buffer.from(bytes).toString('utf-8');

  // Normalize CRLF so Windows files match correctly
  const normalizedOriginal = original.replace(/\r\n/g, '\n');
  const normalizedSearch   = search.replace(/\r\n/g, '\n');
  const normalizedReplace  = (replace ?? '').replace(/\r\n/g, '\n');

  if (!normalizedOriginal.includes(normalizedSearch)) {
    const snippet = normalizedSearch.length > 80
      ? normalizedSearch.slice(0, 80) + '…'
      : normalizedSearch;
    return { ok: false, output: `Text not found in ${filePath}:\n  "${snippet}"` };
  }

  const updated = normalizedOriginal.replace(normalizedSearch, normalizedReplace);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf-8'));

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

async function runCommand(command: string): Promise<ToolResult> {
  if (!command) return { ok: false, output: 'command not specified' };

  const root = workspaceRoot();
  const platform = os.platform();
  const shell    = platform === 'win32' ? 'cmd'    : '/bin/sh';
  const flag     = platform === 'win32' ? '/c'     : '-c';

  return new Promise((resolve) => {
    const proc = cp.spawn(shell, [flag, command], {
      cwd: root,
      timeout: 30_000,
      // Inherit PATH so common tools (git, npm, python…) are found
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      const truncated = combined.length > 4000
        ? combined.slice(0, 4000) + '\n… (output truncated)'
        : combined;
      resolve({
        ok: code === 0,
        output: truncated || `(exited with code ${code})`,
      });
    });

    proc.on('error', (err) => {
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

async function searchFiles(query: string, dirPath?: string): Promise<ToolResult> {
  if (!query) return { ok: false, output: 'search query not specified' };
  const include = dirPath ? `${dirPath}/**` : '**';
  const results = await vscode.workspace.findFiles(include, '**/node_modules/**', 30);

  const matches: string[] = [];
  for (const uri of results) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = Buffer.from(bytes).toString('utf-8');
      if (text.toLowerCase().includes(query.toLowerCase())) {
        const rel = vscode.workspace.asRelativePath(uri);
        const lineNum = text.split('\n').findIndex((l) => l.toLowerCase().includes(query.toLowerCase()));
        matches.push(`${rel}:${lineNum + 1}`);
      }
    } catch { /* skip unreadable files */ }
  }
  return {
    ok: true,
    output: matches.length ? matches.join('\n') : `No results found for "${query}"`,
  };
}
