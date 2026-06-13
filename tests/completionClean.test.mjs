import { test } from 'node:test';
import assert from 'node:assert/strict';

const { clean, isCommentLine, COMMENT_STARTERS } = await import('../out/providers/completionClean.js');

test('module imports without vscode', () => {
  assert.equal(typeof clean, 'function');
  assert.ok(COMMENT_STARTERS.python);
});

test('strips markdown fences', () => {
  const out = clean('```python\nprint(1)\n```', '', 'python');
  assert.equal(out, 'print(1)');
});

test('strips [CURSOR] echo', () => {
  const out = clean('foo[CURSOR]bar', '', 'js');
  assert.equal(out, 'foobar');
});

test('strips echoed prefix line', () => {
  const out = clean('const x = 1;', 'const ', 'js');
  assert.equal(out, 'x = 1;');
});

test('cuts trailing prose after blank line', () => {
  const out = clean('return a + b;\n\nThis function adds two numbers.', '', 'js');
  assert.equal(out, 'return a + b;');
});

test('keeps code after blank line when not prose', () => {
  const out = clean('const a = 1;\n\nconst b = 2;', '', 'js');
  assert.ok(out.includes('const b = 2;'));
});

test('strips conversational filler', () => {
  const out = clean('Here is the code: return 1;', '', 'js');
  assert.equal(out, 'return 1;');
});

test('isCommentLine detects language comment starters', () => {
  assert.equal(isCommentLine('python', '# a comment'), true);
  assert.equal(isCommentLine('typescript', '// note'), true);
  assert.equal(isCommentLine('typescript', 'const x'), false);
  assert.equal(isCommentLine('unknownlang', '// x'), false);
});
