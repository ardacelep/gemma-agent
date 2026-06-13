import { test } from 'node:test';
import assert from 'node:assert/strict';

const { combineInstructions } = await import('../out/llm/instructionsCore.js');

test('module imports without vscode', () => {
  assert.equal(typeof combineInstructions, 'function');
});

test('empty sources → empty string', () => {
  assert.equal(combineInstructions('', ''), '');
  assert.equal(combineInstructions('   ', '  '), '');
});

test('setting only', () => {
  const out = combineInstructions('Always write tests', '');
  assert.ok(out.includes('Always write tests'));
  assert.ok(out.includes('Project rules'));
});

test('both sources are joined', () => {
  const out = combineInstructions('Be terse', '# Rules\nUse tabs');
  assert.ok(out.includes('Be terse'));
  assert.ok(out.includes('Use tabs'));
});

test('cap truncates oversized rules', () => {
  const big = 'x'.repeat(20000);
  const out = combineInstructions('', big, 100);
  assert.ok(out.includes('(rules truncated)'));
  assert.ok(out.length < big.length);
});
