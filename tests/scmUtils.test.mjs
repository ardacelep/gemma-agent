import { test } from 'node:test';
import assert from 'node:assert/strict';

const { capDiff, cleanupCommitMessage, DIFF_TOKEN_CAP } = await import('../out/providers/scmUtils.js');

test('module imports without vscode', () => {
  assert.equal(typeof capDiff, 'function');
});

test('capDiff leaves small diffs untouched', () => {
  const d = 'diff --git a/x b/x\n+hello';
  assert.equal(capDiff(d), d);
});

test('capDiff truncates oversized diffs with marker', () => {
  const d = 'x'.repeat(DIFF_TOKEN_CAP * 4 + 5000);
  const out = capDiff(d);
  assert.ok(out.length < d.length);
  assert.ok(out.endsWith('(diff truncated)'));
});

test('cleanupCommitMessage strips fences and surrounding quotes', () => {
  assert.equal(cleanupCommitMessage('```\nfix: bug\n```'), 'fix: bug');
  assert.equal(cleanupCommitMessage('"feat: add x"'), 'feat: add x');
  assert.equal(cleanupCommitMessage('  chore: cleanup  '), 'chore: cleanup');
});
