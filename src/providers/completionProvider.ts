import * as vscode from 'vscode';
import { ollamaGenerate, resolveRoleModel } from '../llm/client';
import { fimTemplateFor } from '../llm/modelCatalog';
import { COMMENT_STARTERS, clean, isCommentLine } from './completionClean';
import { StatusBarManager } from '../statusBar';
import { BackendService } from '../llm/backendService';

/** Line-comment token for a language, defaulting to //. */
function lineComment(lang: string): string {
  const s = COMMENT_STARTERS[lang]?.[0];
  return s && (s === '#' || s === '--' || s === '//') ? s : '//';
}

/** Brief context from other visible editor tabs (bounded), as comment lines. */
function gatherOpenTabsContext(doc: vscode.TextDocument, lang: string): string {
  const others = vscode.window.visibleTextEditors
    .map((e) => e.document)
    .filter((d) => d.uri.scheme === 'file' && d.uri.toString() !== doc.uri.toString());
  if (others.length === 0) return '';
  const cm = lineComment(lang);
  const parts: string[] = [];
  let budget = 600;
  for (const d of others) {
    const head = d.getText(new vscode.Range(0, 0, Math.min(d.lineCount, 14), 0)).trim();
    if (!head) continue;
    const body = head.slice(0, 300).split('\n').map((l) => `${cm} ${l}`).join('\n');
    const block = `${cm} ${vscode.workspace.asRelativePath(d.uri)}:\n${body}`;
    if (block.length > budget) break;
    parts.push(block);
    budget -= block.length;
  }
  return parts.length ? parts.join('\n') + '\n' : '';
}

/** Raw prefix/suffix around the cursor (for FIM and prompt building). */
function buildContext(doc: vscode.TextDocument, position: vscode.Position): { prefix: string; suffix: string } {
  const prefixStart = Math.max(0, position.line - 60);
  const prefix = doc.getText(new vscode.Range(prefixStart, 0, position.line, position.character));
  const suffixEnd = Math.min(doc.lineCount, position.line + 20);
  const suffix = doc.getText(new vscode.Range(position.line, position.character, suffixEnd, 0));
  return { prefix, suffix };
}

/** Chat-style prompt for general (non-FIM) models. */
function buildChatPrompt(lang: string, prefix: string, suffix: string): string {
  if (suffix.trim()) {
    return (
      `Complete the code at [CURSOR]. Output ONLY the inserted text, no explanation.\n\n` +
      `\`\`\`${lang}\n${prefix}[CURSOR]${suffix.trimEnd()}\n\`\`\``
    );
  }
  return `\`\`\`${lang}\n${prefix}`;
}

const SYSTEM =
  'You are a code completion AI. ' +
  'Output ONLY the raw text to insert at the cursor — no markdown fences, no explanations, no repetition of existing code. ' +
  'Keep the completion short: finish the current expression or at most one small block. ' +
  'Match the indentation of the surrounding code exactly.';

/** Light cleanup for FIM output (raw middle insertion — no prose to strip). */
function cleanFim(raw: string): string {
  return raw.replace(/^```[\w-]*\n?/, '').replace(/\n?```\s*$/, '');
}

export class GemmaCompletionProvider implements vscode.InlineCompletionItemProvider {
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private activeRequest: AbortController | undefined;
  /** Resolver of a superseded request — must be settled so VS Code never waits forever. */
  private pendingResolve: ((value: vscode.InlineCompletionList | null) => void) | undefined;
  /** Completion models we've already warned about (avoid repeat toasts). */
  private warnedModels = new Set<string>();

  constructor(
    private readonly statusBar?: StatusBarManager,
    private readonly backend?: BackendService
  ) {}

  /**
   * If a dedicated completion model is configured but not installed, warn once
   * (with a Pull action) and fall back to the main model for this request.
   */
  private resolveAvailableCompletionModel(): string {
    const configured = resolveRoleModel('completion');
    const mainModel = resolveRoleModel('chat');
    if (!configured || configured === mainModel) return configured;
    const state = this.backend?.state;
    if (!state || state.serverState !== 'ready') return configured; // can't tell — try as-is
    if (state.models.includes(configured)) return configured;
    if (!this.warnedModels.has(configured)) {
      this.warnedModels.add(configured);
      if (state.capabilities.canPull) {
        void vscode.window.showWarningMessage(
          `Completion model "${configured}" is not installed — using the main model for now.`,
          `Pull ${configured}`
        ).then((pick) => {
          if (pick) void vscode.commands.executeCommand('gemmaAgent.pullModel', configured);
        });
      }
    }
    return mainModel; // graceful fallback
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionList | null> {
    const cfg = vscode.workspace.getConfiguration('gemmaAgent');
    if (!cfg.get<boolean>('completionEnabled', true)) return null;

    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    const lang = document.languageId;

    // Per-language toggle: exact language id → "*" wildcard → enabled
    const langMap = cfg.get<Record<string, boolean>>('completionLanguages', {});
    if (!(langMap[lang] ?? langMap['*'] ?? true)) return null;

    // Don't trigger on blank/whitespace-only prefix
    if (!linePrefix.trim()) return null;

    // Don't trigger if the user is just writing a comment
    if (isCommentLine(lang, linePrefix)) return null;

    // Don't trigger if only 1-2 meaningful chars typed (too early, noisy)
    if (linePrefix.trim().length < 3) return null;

    // Don't re-trigger immediately if invoked automatically (already showing)
    if (context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
      // Let debounce handle it
    }

    return new Promise((resolve) => {
      // Settle the superseded request before replacing its debounce timer
      this.pendingResolve?.(null);
      this.pendingResolve = resolve;

      const finish = (value: vscode.InlineCompletionList | null) => {
        if (this.pendingResolve === resolve) this.pendingResolve = undefined;
        this.statusBar?.setBusy(false);
        resolve(value);
      };

      clearTimeout(this.debounceTimer);
      const debounceMs = cfg.get<number>('completionDebounceMs', 600);

      this.debounceTimer = setTimeout(async () => {
        if (token.isCancellationRequested) return finish(null);

        this.activeRequest?.abort();
        this.activeRequest = new AbortController();

        const completionModel = this.resolveAvailableCompletionModel();
        const fimOff = cfg.get<string>('completionFim', 'auto') === 'off';
        const useFim = !fimOff && fimTemplateFor(completionModel) !== 'none';
        const maxTokens = cfg.get<number>('completionMaxTokens', 150);
        const ctx = buildContext(document, position);
        const tabsCtx = cfg.get<boolean>('completionContextTabs', true) ? gatherOpenTabsContext(document, lang) : '';
        const prefix = tabsCtx + ctx.prefix;
        const suffix = ctx.suffix;
        this.statusBar?.setBusy(true);

        // One generation, FIM or chat-style depending on the model.
        const generate = (temperature?: number) => useFim
          ? ollamaGenerate({ prompt: prefix, suffix, model: completionModel, maxTokens, temperature: temperature ?? 0.1, signal: this.activeRequest!.signal })
          : ollamaGenerate({ prompt: buildChatPrompt(lang, prefix, suffix), system: SYSTEM, model: completionModel, maxTokens, temperature, signal: this.activeRequest!.signal });
        const cleanOut = (raw: string) => useFim ? cleanFim(raw) : clean(raw, linePrefix, lang);

        try {
          const raw = await generate();
          if (token.isCancellationRequested || !raw.trim()) return finish(null);

          const completion = cleanOut(raw);
          if (!completion.trim()) return finish(null);

          // Reject if the completion looks like it's re-writing existing suffix
          const nextLineText = position.line + 1 < document.lineCount
            ? document.lineAt(position.line + 1).text.trim()
            : '';
          if (nextLineText && completion.includes(nextLineText)) return finish(null);

          const range = new vscode.Range(position, position);
          const items = [new vscode.InlineCompletionItem(completion, range)];

          // Optional alternatives (cycled with Alt+] / Alt+[). VS Code needs the
          // full list up front, so each extra suggestion is one more generation.
          const alternatives = Math.min(3, Math.max(1, cfg.get<number>('completionAlternatives', 1)));
          for (let n = 1; n < alternatives && !token.isCancellationRequested; n++) {
            try {
              const alt = cleanOut(await generate(0.8));
              if (alt.trim() &&
                  !items.some((it) => it.insertText === alt) &&
                  !(nextLineText && alt.includes(nextLineText))) {
                items.push(new vscode.InlineCompletionItem(alt, range));
              }
            } catch {
              break;
            }
          }

          finish(new vscode.InlineCompletionList(items));
        } catch {
          finish(null);
        }
      }, debounceMs);

      token.onCancellationRequested(() => {
        clearTimeout(this.debounceTimer);
        this.activeRequest?.abort();
        finish(null);
      });
    });
  }

  dispose() {
    clearTimeout(this.debounceTimer);
    this.activeRequest?.abort();
    this.pendingResolve?.(null);
    this.pendingResolve = undefined;
  }
}
