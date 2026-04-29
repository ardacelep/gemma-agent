import * as vscode from 'vscode';
import * as path from 'path';

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
      'Açık bir workspace klasörü yok. ' +
      'VS Code\'da "File → Open Folder" ile bir klasör açın, ardından tekrar deneyin.'
    );
  }
  return root;
}

function resolveUri(filePath: string): vscode.Uri {
  if (path.isAbsolute(filePath)) return vscode.Uri.file(filePath);
  return vscode.Uri.file(path.join(workspaceRoot(), filePath));
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
        return await listFiles(call.path as string ?? '.');
      case 'search_files':
        return await searchFiles(call.query as string, call.path as string);
      default:
        return { ok: false, output: `Bilinmeyen araç: ${call.tool}` };
    }
  } catch (err) {
    return { ok: false, output: `Hata: ${(err as Error).message}` };
  }
}

async function createFile(filePath: string, content: string): Promise<ToolResult> {
  if (!filePath) return { ok: false, output: 'path belirtilmedi' };
  const uri = resolveUri(filePath);

  // Create parent directories if needed
  const parentUri = vscode.Uri.file(path.dirname(uri.fsPath));
  await vscode.workspace.fs.createDirectory(parentUri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(content ?? '', 'utf-8'));

  return { ok: true, output: `Dosya oluşturuldu: ${filePath}` };
}

async function editFile(filePath: string, search: string, replace: string): Promise<ToolResult> {
  if (!filePath) return { ok: false, output: 'path belirtilmedi' };
  if (search === undefined) return { ok: false, output: 'search metni belirtilmedi' };

  const uri = resolveUri(filePath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const original = Buffer.from(bytes).toString('utf-8');

  if (!original.includes(search)) {
    return { ok: false, output: `"${search.slice(0, 60)}..." metni dosyada bulunamadı` };
  }

  const updated = original.replace(search, replace ?? '');
  await vscode.workspace.fs.writeFile(uri, Buffer.from(updated, 'utf-8'));

  return { ok: true, output: `Düzenlendi: ${filePath}` };
}

async function readFile(filePath: string): Promise<ToolResult> {
  if (!filePath) return { ok: false, output: 'path belirtilmedi' };
  const uri = resolveUri(filePath);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const content = Buffer.from(bytes).toString('utf-8');
  const lines = content.split('\n');
  // Cap at 300 lines to avoid flooding context
  const preview = lines.length > 300
    ? lines.slice(0, 300).join('\n') + `\n... (+${lines.length - 300} satır)`
    : content;
  return { ok: true, output: preview };
}

async function runCommand(command: string): Promise<ToolResult> {
  if (!command) return { ok: false, output: 'komut belirtilmedi' };

  return new Promise((resolve) => {
    const terminal = vscode.window.terminals.find((t) => t.name === 'Gemma Agent') ??
      vscode.window.createTerminal({ name: 'Gemma Agent' });
    terminal.show(true);
    terminal.sendText(command);
    // VS Code doesn't expose terminal output — report that command was sent
    resolve({ ok: true, output: `Komut terminale gönderildi: ${command}` });
  });
}

async function listFiles(dirPath: string): Promise<ToolResult> {
  const uri = resolveUri(dirPath);
  const entries = await vscode.workspace.fs.readDirectory(uri);
  const lines = entries.map(([name, type]) => {
    const icon = type === vscode.FileType.Directory ? '📁' : '📄';
    return `${icon} ${name}`;
  });
  return { ok: true, output: lines.join('\n') || '(boş dizin)' };
}

async function searchFiles(query: string, dirPath?: string): Promise<ToolResult> {
  if (!query) return { ok: false, output: 'arama terimi belirtilmedi' };
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
    output: matches.length ? matches.join('\n') : `"${query}" için sonuç bulunamadı`,
  };
}
