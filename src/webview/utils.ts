import * as vscode from 'vscode';
import * as crypto from 'crypto';

export function getNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function getWebviewUri(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  pathList: string[]
): vscode.Uri {
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...pathList));
}
