// Pure instruction combiner. MUST NOT import vscode (kept unit-testable).
import { estimateTokens } from './contextWindow';

/**
 * Combine the user's `customInstructions` setting and the workspace
 * `.gemma/rules.md` file into one suffix, capped to ~capTokens tokens.
 */
export function combineInstructions(setting: string, rulesFile: string, capTokens = 2000): string {
  const parts: string[] = [];
  if (setting && setting.trim()) parts.push(setting.trim());
  if (rulesFile && rulesFile.trim()) parts.push(rulesFile.trim());
  if (parts.length === 0) return '';

  let combined = parts.join('\n\n');
  const capChars = capTokens * 4;
  if (estimateTokens(combined) > capTokens) {
    combined = combined.slice(0, capChars) + '\n…(rules truncated)';
  }
  return `\n\n## Project rules (from the user — follow these)\n${combined}`;
}
