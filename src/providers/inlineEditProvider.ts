import * as vscode from 'vscode';
import { OllamaMessage, describeOllamaError, isOllamaRunning, ollamaChat } from '../llm/client';
import { getInstructionSuffix } from '../llm/instructions';

/**
 * Inline edit: streams the model's rewrite directly into the editor as one
 * undo unit, highlights it with a decoration, and offers Accept / Reject
 * CodeLenses (⌘⏎ / Esc). Works on a selection (edit mode) or at the cursor
 * (insert mode). Continue.dev-style — VS Code extensions cannot render
 * Copilot's proprietary floating inline-chat widget.
 */

const SYSTEM = `You are an inline code editor. Apply the user's instruction and return ONLY code.
Rules:
- Output raw code only — no markdown fences, no explanations, no comments about what changed.
- Preserve the EXACT original indentation style (spaces vs tabs, indentation depth).
- Match the language idioms and surrounding code style.
- Do NOT add or remove blank lines at the start or end of the output unless the instruction requires it.`;

/** Trailing chars held back per chunk so closing fences / [CURSOR] echoes can be stripped. */
const STREAM_HOLDBACK = 8;

interface InlineEditSession {
  editor: vscode.TextEditor;
  docUri: string;
  startOffset: number;
  originalText: string; // '' in insert mode
  streamedLength: number;
  state: 'streaming' | 'review';
  abort: AbortController;
  applyingEdit: boolean; // true while our own edits are in flight
}

let session: InlineEditSession | undefined;
let decorationType: vscode.TextEditorDecorationType | undefined;
const codeLensEmitter = new vscode.EventEmitter<void>();

class InlineEditCodeLensProvider implements vscode.CodeLensProvider {
  onDidChangeCodeLenses = codeLensEmitter.event;

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!session || session.state !== 'review') return [];
    if (document.uri.toString() !== session.docUri) return [];
    const line = document.positionAt(session.startOffset).line;
    const range = new vscode.Range(line, 0, line, 0);
    const accept = process.platform === 'darwin' ? '⌘⏎' : 'Ctrl+Enter';
    return [
      new vscode.CodeLens(range, { title: `✓ Accept (${accept})`, command: 'gemmaAgent.inlineEditAccept' }),
      new vscode.CodeLens(range, { title: '✗ Reject (Esc)', command: 'gemmaAgent.inlineEditReject' }),
    ];
  }
}

export function registerInlineEdit(context: vscode.ExtensionContext): void {
  decorationType = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('diffEditor.insertedTextBackground'),
  });
  context.subscriptions.push(
    decorationType,
    vscode.languages.registerCodeLensProvider('*', new InlineEditCodeLensProvider()),
    vscode.commands.registerCommand('gemmaAgent.inlineEditAccept', acceptInlineEdit),
    vscode.commands.registerCommand('gemmaAgent.inlineEditReject', rejectInlineEdit),
    vscode.workspace.onDidChangeTextDocument(onDocChanged),
    vscode.workspace.onDidCloseTextDocument(onDocClosed),
    { dispose: () => void endSession() }
  );
}

function buildEditPrompt(code: string, lang: string, instruction: string): string {
  return `Language: ${lang}
Instruction: ${instruction}

Code to edit:
\`\`\`${lang}
${code}
\`\`\`

Return only the edited code:`;
}

function buildInsertPrompt(before: string, after: string, lang: string, instruction: string): string {
  return `Language: ${lang}
Instruction: ${instruction}

The new code will be inserted at [CURSOR]. Surrounding code:
\`\`\`${lang}
${before}[CURSOR]${after}
\`\`\`

Return only the code to insert at [CURSOR]:`;
}

export async function inlineEdit(editor: vscode.TextEditor): Promise<void> {
  if (!await isOllamaRunning()) {
    vscode.window.showErrorMessage('Ollama is not running. Start it from the Gemma chat panel or run `ollama serve`.');
    return;
  }

  // Starting a new session auto-rejects a pending one
  if (session) await rejectInlineEdit();

  const hasSelection = !editor.selection.isEmpty;
  const instruction = await vscode.window.showInputBox({
    title: hasSelection ? 'Gemma Inline Edit' : 'Gemma Inline Edit — insert at cursor',
    prompt: hasSelection ? 'What should be done with the selected code?' : 'What code should be inserted at the cursor?',
    placeHolder: hasSelection
      ? 'e.g. "add docstrings", "convert to async", "fix errors"'
      : 'e.g. "a function that validates the config object"',
    ignoreFocusOut: true,
  });
  if (!instruction) return;

  const doc = editor.document;
  const lang = doc.languageId;
  const selection = editor.selection;
  const startOffset = doc.offsetAt(selection.start);
  const originalText = hasSelection ? doc.getText(selection) : '';

  let prompt: string;
  if (hasSelection) {
    prompt = buildEditPrompt(originalText, lang, instruction);
  } else {
    const beforeRange = new vscode.Range(new vscode.Position(Math.max(0, selection.start.line - 40), 0), selection.start);
    const afterRange = new vscode.Range(selection.end, new vscode.Position(Math.min(doc.lineCount - 1, selection.end.line + 15), 0));
    prompt = buildInsertPrompt(doc.getText(beforeRange), doc.getText(afterRange), lang, instruction);
  }

  session = {
    editor,
    docUri: doc.uri.toString(),
    startOffset,
    originalText,
    streamedLength: 0,
    state: 'streaming',
    abort: new AbortController(),
    applyingEdit: false,
  };
  await vscode.commands.executeCommand('setContext', 'gemmaAgent.inlineEditActive', true);

  // Edit mode: remove the selection first — same undo unit as the stream
  if (hasSelection) {
    session.applyingEdit = true;
    const removed = await editor.edit((eb) => eb.delete(selection), { undoStopBefore: true, undoStopAfter: false });
    session.applyingEdit = false;
    if (!removed) {
      await endSession();
      return;
    }
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `Gemma: ${instruction}` },
      () => streamResponse(prompt, session!.abort.signal)
    );
  } catch (err) {
    const wasAbort = (err as Error).name === 'AbortError';
    if (!wasAbort) {
      vscode.window.showErrorMessage(`Gemma inline edit failed: ${describeOllamaError(err)}`);
    }
    if (session) await restoreOriginal();
    return;
  }

  if (!session) return; // torn down mid-stream (doc closed, rejected)

  if (session.state === 'streaming') {
    if (session.streamedLength === 0) {
      vscode.window.showInformationMessage('Gemma: No changes suggested.');
      await restoreOriginal();
      return;
    }
    session.state = 'review';
  }
  codeLensEmitter.fire();
}

async function streamResponse(prompt: string, signal: AbortSignal): Promise<void> {
  const messages: OllamaMessage[] = [
    { role: 'system', content: SYSTEM + getInstructionSuffix() },
    { role: 'user', content: prompt },
  ];

  let pending = '';
  let firstLineChecked = false;

  for await (const chunk of ollamaChat({ messages, signal })) {
    if (!session || session.state !== 'streaming') return;
    pending += chunk;

    // Drop a leading ```lang fence line once the full first line has arrived
    if (!firstLineChecked) {
      const nl = pending.indexOf('\n');
      if (nl === -1) continue;
      if (/^```[\w-]*$/.test(pending.slice(0, nl).trim())) {
        pending = pending.slice(nl + 1);
      }
      firstLineChecked = true;
    }

    // Hold back a tail that might be part of a closing fence or [CURSOR] echo
    if (pending.length > STREAM_HOLDBACK) {
      const out = pending.slice(0, pending.length - STREAM_HOLDBACK).replace(/\[CURSOR\]/g, '');
      pending = pending.slice(pending.length - STREAM_HOLDBACK);
      if (out) await insertChunk(out);
    }
  }

  if (!session || session.state !== 'streaming') return;

  // End of stream — strip the closing fence / cursor echo and flush the rest
  let tail = pending.replace(/\[CURSOR\]/g, '');
  if (!firstLineChecked && /^```[\w-]*$/.test(tail.trim())) tail = '';
  tail = tail.replace(/\s*```\s*$/, '').replace(/\s+$/, '');
  if (tail) await insertChunk(tail);
}

async function insertChunk(text: string): Promise<void> {
  if (!session) return;
  const { editor } = session;
  const pos = editor.document.positionAt(session.startOffset + session.streamedLength);
  session.applyingEdit = true;
  let ok = false;
  try {
    ok = await editor.edit((eb) => eb.insert(pos, text), { undoStopBefore: false, undoStopAfter: false });
  } finally {
    session.applyingEdit = false;
  }
  if (!ok) throw new Error('Could not apply the edit to the document.');
  session.streamedLength += text.length;
  updateDecoration();
}

function updateDecoration(): void {
  if (!session || !decorationType) return;
  const doc = session.editor.document;
  const range = new vscode.Range(
    doc.positionAt(session.startOffset),
    doc.positionAt(session.startOffset + session.streamedLength)
  );
  session.editor.setDecorations(decorationType, session.streamedLength > 0 ? [range] : []);
}

async function acceptInlineEdit(): Promise<void> {
  if (!session) return;
  const { editor } = session;
  // The streamed text is already in the document — just add an undo stop
  session.applyingEdit = true;
  try {
    await editor.edit(() => { /* no-op for the undo stop */ }, { undoStopBefore: false, undoStopAfter: true });
  } finally {
    session.applyingEdit = false;
  }
  await endSession();
}

async function rejectInlineEdit(): Promise<void> {
  if (!session) return;
  session.abort.abort(); // stop the stream if still running
  await restoreOriginal();
}

async function restoreOriginal(): Promise<void> {
  if (!session) return;
  const { editor, startOffset, streamedLength, originalText } = session;
  const doc = editor.document;
  if (streamedLength > 0 || originalText) {
    const range = new vscode.Range(doc.positionAt(startOffset), doc.positionAt(startOffset + streamedLength));
    const we = new vscode.WorkspaceEdit();
    we.replace(doc.uri, range, originalText);
    session.applyingEdit = true;
    try {
      await vscode.workspace.applyEdit(we);
    } finally {
      if (session) session.applyingEdit = false;
    }
  }
  await endSession();
}

async function endSession(): Promise<void> {
  if (!session) return;
  const s = session;
  session = undefined;
  s.abort.abort();
  if (decorationType) {
    try { s.editor.setDecorations(decorationType, []); } catch { /* editor disposed */ }
  }
  codeLensEmitter.fire();
  await vscode.commands.executeCommand('setContext', 'gemmaAgent.inlineEditActive', false);
}

/** Track foreign edits: shift offsets, or bail out when the live range is touched. */
function onDocChanged(e: vscode.TextDocumentChangeEvent): void {
  if (!session || session.applyingEdit) return;
  if (e.document.uri.toString() !== session.docUri) return;

  const start = session.startOffset;
  const end = session.startOffset + session.streamedLength;
  let touchedInside = false;
  let touchedBoundary = false;

  for (const change of e.contentChanges) {
    const delta = change.text.length - change.rangeLength;
    const cStart = change.rangeOffset;
    const cEnd = change.rangeOffset + change.rangeLength;
    if (cEnd <= start) {
      session.startOffset += delta;
    } else if (cStart >= start && cEnd <= end) {
      session.streamedLength += delta;
      touchedInside = true;
    } else {
      touchedBoundary = true;
    }
  }

  if (touchedBoundary) {
    // The proposal region was corrupted — leave the document as-is
    void endSession();
    return;
  }
  if (touchedInside) {
    if (session.state === 'streaming') {
      // The user started typing into the proposal — stop streaming, let them review
      session.abort.abort();
      session.state = 'review';
      codeLensEmitter.fire();
    }
    updateDecoration();
  }
}

function onDocClosed(doc: vscode.TextDocument): void {
  if (session && doc.uri.toString() === session.docUri) {
    void endSession();
  }
}
