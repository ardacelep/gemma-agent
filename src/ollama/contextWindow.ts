import { OllamaMessage } from './client';

/** Rough estimate: ~4 characters per token. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Per-message overhead (role tags, separators). */
export function estimateMessageTokens(m: OllamaMessage): number {
  return estimateTokens(m.content) + 4;
}

/** Input budget left after reserving room for the response and a safety margin. */
export function computeBudget(numCtx: number, maxTokens: number): number {
  return Math.max(512, numCtx - maxTokens - 256);
}

export interface FitResult {
  messages: OllamaMessage[];
  droppedCount: number;
}

function totalTokens(messages: OllamaMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
}

/**
 * Trim a conversation so it fits the token budget.
 *
 * Pinned: the system message (index 0, if present) and the final message.
 * Drop order:
 *   1. Tool-exchange pairs, oldest first (assistant `<tool_call>` + its
 *      `Tool result (` reply) — these are the bulkiest and least useful.
 *   2. Oldest remaining middle messages.
 *   3. Degenerate case (one huge final message): truncate its middle,
 *      keeping the head (the instruction) and tail intact.
 *
 * Never mutates the input array or its messages.
 */
export function fitMessages(messages: OllamaMessage[], budgetTokens: number): FitResult {
  const current = [...messages];
  if (totalTokens(current) <= budgetTokens) {
    return { messages: current, droppedCount: 0 };
  }

  const start = current[0]?.role === 'system' ? 1 : 0;
  let dropped = 0;

  const isToolExchangeStart = (i: number): boolean =>
    current[i].role === 'assistant' &&
    current[i].content.includes('<tool_call>') &&
    current[i + 1]?.role === 'user' &&
    current[i + 1].content.startsWith('Tool result (');

  // Pass 1 — drop tool-exchange pairs, oldest first (keep the final message)
  let i = start;
  while (totalTokens(current) > budgetTokens && i < current.length - 2) {
    if (isToolExchangeStart(i)) {
      current.splice(i, 2);
      dropped += 2;
    } else {
      i++;
    }
  }

  // Pass 2 — drop oldest middle messages (keep system + final message)
  while (totalTokens(current) > budgetTokens && current.length - start > 1) {
    current.splice(start, 1);
    dropped += 1;
  }

  // Pass 3 — still over budget: truncate the middle of the final message
  if (totalTokens(current) > budgetTokens && current.length > 0) {
    const lastIdx = current.length - 1;
    const last = current[lastIdx];
    const overheadTokens = totalTokens(current) - estimateTokens(last.content);
    const charBudget = Math.max(1_000, (budgetTokens - overheadTokens) * 4);
    if (last.content.length > charBudget) {
      const headLen = Math.max(500, Math.floor(charBudget * 0.6));
      const tailLen = Math.max(200, Math.floor(charBudget * 0.3));
      current[lastIdx] = {
        ...last,
        content:
          last.content.slice(0, headLen) +
          '\n…[context trimmed to fit the model window]…\n' +
          last.content.slice(-tailLen),
      };
    }
  }

  return { messages: current, droppedCount: dropped };
}
