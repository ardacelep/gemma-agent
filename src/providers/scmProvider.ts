import * as vscode from 'vscode';
import * as cp from 'child_process';
import { OllamaMessage, describeOllamaError, isOllamaRunning, ollamaChat } from '../ollama/client';
import { estimateTokens } from '../ollama/contextWindow';

const DIFF_TOKEN_CAP = 6_000;

// Minimal surface of the built-in Git extension API (getAPI(1))
interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: { value: string };
  diff(cached?: boolean): Promise<string>;
}
interface GitAPI {
  repositories: GitRepository[];
}

async function getGitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) return undefined;
  if (!ext.isActive) await ext.activate();
  return ext.exports?.getAPI?.(1);
}

function execGitDiff(cwd: string, staged: boolean): Promise<string> {
  return new Promise((resolve) => {
    cp.exec(
      `git diff ${staged ? '--staged ' : ''}--no-color`,
      { cwd, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout) => resolve(err ? '' : stdout)
    );
  });
}

function capDiff(diff: string): string {
  if (estimateTokens(diff) <= DIFF_TOKEN_CAP) return diff;
  return diff.slice(0, DIFF_TOKEN_CAP * 4) + '\n… (diff truncated)';
}

function cleanupCommitMessage(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
  text = text.replace(/^["'`]+|["'`]+$/g, '');
  return text.trim();
}

export function registerScmCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'gemmaAgent.generateCommitMessage',
      async (sourceControl?: vscode.SourceControl) => {
        if (!await isOllamaRunning()) {
          vscode.window.showErrorMessage('Ollama is not running. Start it from the Gemma chat panel or run `ollama serve`.');
          return;
        }

        const api = await getGitApi();
        if (!api || api.repositories.length === 0) {
          vscode.window.showWarningMessage('Gemma: No Git repository found in this workspace.');
          return;
        }

        // When invoked from the SCM title bar, match the repository that was clicked
        let repo = api.repositories[0];
        if (sourceControl?.rootUri) {
          repo = api.repositories.find((r) => r.rootUri.toString() === sourceControl.rootUri!.toString()) ?? repo;
        }

        let diff = '';
        let usedWorkingTree = false;
        try {
          diff = await repo.diff(true); // staged changes
          if (!diff.trim()) {
            diff = await repo.diff(false);
            usedWorkingTree = true;
          }
        } catch {
          diff = await execGitDiff(repo.rootUri.fsPath, true);
          if (!diff.trim()) {
            diff = await execGitDiff(repo.rootUri.fsPath, false);
            usedWorkingTree = true;
          }
        }

        if (!diff.trim()) {
          vscode.window.showInformationMessage('Gemma: No changes to describe.');
          return;
        }

        const messages: OllamaMessage[] = [
          {
            role: 'system',
            content: 'You write git commit messages. Output ONLY the commit message — no markdown fences, no quotes, no commentary.',
          },
          {
            role: 'user',
            content:
              'Write a commit message for this diff. Use the conventional commit style (type: subject). ' +
              'The subject line must be at most 72 characters, in the imperative mood. ' +
              'Add a short body (1-3 bullet points) only if the change is non-trivial.\n\n' +
              capDiff(diff),
          },
        ];

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.SourceControl },
          async () => {
            let message = '';
            try {
              for await (const chunk of ollamaChat({ messages })) {
                message += chunk;
                repo.inputBox.value = message.trimStart();
              }
              repo.inputBox.value = cleanupCommitMessage(message);
            } catch (err) {
              vscode.window.showErrorMessage(`Gemma: ${describeOllamaError(err)}`);
              return;
            }
            if (usedWorkingTree) {
              vscode.window.setStatusBarMessage('Gemma: nothing staged — described working-tree changes instead', 5000);
            }
          }
        );
      }
    )
  );
}
