import { test } from 'node:test';
import assert from 'node:assert/strict';

const { estimateTokens, computeBudget, fitMessages } = await import('../out/ollama/contextWindow.js');

test('module imports without vscode', () => {
  assert.equal(typeof fitMessages, 'function');
});

test('estimateTokens ~ chars/4', () => {
  assert.equal(estimateTokens('aaaa'), 1);
  assert.equal(estimateTokens('a'.repeat(40)), 10);
});

test('computeBudget floors at 512', () => {
  assert.equal(computeBudget(2048, 4096), 512);
  assert.equal(computeBudget(8192, 4096), 8192 - 4096 - 256);
});

test('under budget: untouched', () => {
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
  const r = fitMessages(msgs, 1000);
  assert.equal(r.droppedCount, 0);
  assert.equal(r.messages.length, 2);
});

test('tool-exchange pairs dropped before plain messages; system + last pinned', () => {
  const big = 'x'.repeat(4000); // ~1000 tokens
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old question' },
    { role: 'assistant', content: '<tool_call>{"tool":"read_file"}</tool_call>' + big },
    { role: 'user', content: 'Tool result (read_file): SUCCESS\n' + big },
    { role: 'assistant', content: 'done' },
    { role: 'user', content: 'new question' },
  ];
  const r = fitMessages(msgs, 600);
  assert.ok(!r.messages.some((m) => m.content.startsWith('Tool result')), 'tool result dropped');
  assert.equal(r.messages[0].role, 'system', 'system pinned');
  assert.equal(r.messages[r.messages.length - 1].content, 'new question', 'last pinned');
  assert.ok(r.droppedCount > 0);
});

test('degenerate single huge message is middle-truncated, head preserved', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'INSTRUCTION: do x\n' + 'y'.repeat(100000) },
  ];
  const r = fitMessages(msgs, 500);
  const last = r.messages[r.messages.length - 1].content;
  assert.ok(last.includes('context trimmed'), 'has truncation marker');
  assert.ok(last.startsWith('INSTRUCTION'), 'head preserved');
  assert.ok(estimateTokens(last) < 2000, 'shrunk');
});

test('does not mutate the input array', () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'a'.repeat(8000) },
    { role: 'assistant', content: 'b'.repeat(8000) },
    { role: 'user', content: 'last' },
  ];
  const before = msgs.length;
  fitMessages(msgs, 200);
  assert.equal(msgs.length, before, 'original length unchanged');
});
