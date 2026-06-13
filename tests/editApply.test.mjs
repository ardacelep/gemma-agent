import { test } from 'node:test';
import assert from 'node:assert/strict';

const { applyEdit } = await import('../out/agent/editApply.js');

test('module imports without vscode', () => {
  assert.equal(typeof applyEdit, 'function');
});

test('basic replace', () => {
  const r = applyEdit('const a = 1;', 'a = 1', 'a = 2');
  assert.ok(r.ok);
  assert.equal(r.content, 'const a = 2;');
});

test('CRLF in original matches LF search', () => {
  const r = applyEdit('line1\r\nline2\r\n', 'line1\nline2', 'X');
  assert.ok(r.ok);
  assert.equal(r.content, 'X\n');
});

test('search not found → ok:false with error', () => {
  const r = applyEdit('hello', 'world', 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});

test('only the first occurrence is replaced (mirrors String.replace)', () => {
  const r = applyEdit('a a a', 'a', 'b');
  assert.equal(r.content, 'b a a');
});
