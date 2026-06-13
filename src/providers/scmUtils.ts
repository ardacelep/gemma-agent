// Pure commit-message helpers. MUST NOT import vscode (kept unit-testable).
import { estimateTokens } from '../ollama/contextWindow';

export const DIFF_TOKEN_CAP = 6_000;

/** Trim a diff to roughly DIFF_TOKEN_CAP tokens for the prompt. */
export function capDiff(diff: string): string {
  if (estimateTokens(diff) <= DIFF_TOKEN_CAP) return diff;
  return diff.slice(0, DIFF_TOKEN_CAP * 4) + '\n… (diff truncated)';
}

/** Strip markdown fences and surrounding quotes the model may add around the message. */
export function cleanupCommitMessage(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
  text = text.replace(/^["'`]+|["'`]+$/g, '');
  return text.trim();
}
