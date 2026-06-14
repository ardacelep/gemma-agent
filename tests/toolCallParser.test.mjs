import { test } from 'node:test';
import assert from 'node:assert/strict';

// Importing the compiled module must NOT throw (would mean it pulled in vscode)
const mod = await import('../out/agent/toolCallParser.js');
const { parseToolCall, sanitizeToolCall, stripMarkdownLink, TOOL_NAMES, TOOL_CALL_RE, FENCED_TOOL_RE, TOOL_CALL_SCHEMA } = mod;

test('module imports without vscode', () => {
  assert.equal(typeof parseToolCall, 'function');
  assert.ok(Array.isArray(TOOL_NAMES) || TOOL_NAMES.length >= 0);
});

test('pass 1: clean JSON parses', () => {
  const call = parseToolCall('{"tool":"read_file","path":"src/x.ts"}');
  assert.equal(call.tool, 'read_file');
  assert.equal(call.path, 'src/x.ts');
});

test('pass 2: literal newlines inside string values are repaired', () => {
  const raw = '{"tool":"create_file","path":"a.txt","content":"line1\nline2"}';
  const call = parseToolCall(raw);
  assert.equal(call.tool, 'create_file');
  assert.equal(call.content, 'line1\nline2');
});

test('pass 3: regex fallback recovers content with stray characters', () => {
  // Broken JSON (unescaped quote in content) — pass 1/2 fail, pass 3 extracts fields
  const raw = '{"tool":"create_file","path":"a.py","content":"print("hi")"}';
  const call = parseToolCall(raw);
  assert.equal(call.tool, 'create_file');
  assert.equal(call.path, 'a.py');
  assert.ok(call.content.includes('print'));
});

test('fenced JSON block matches via FENCED_TOOL_RE', () => {
  const text = '```json\n{"tool":"list_files","path":"src"}\n```';
  const m = text.match(FENCED_TOOL_RE);
  assert.ok(m, 'fenced regex should match');
  const call = parseToolCall(m[1]);
  assert.equal(call.tool, 'list_files');
});

test('tool_call tags match via TOOL_CALL_RE', () => {
  const text = '<tool_call>\n{"tool":"read_file","path":"x"}\n</tool_call>';
  const m = text.match(TOOL_CALL_RE);
  assert.ok(m);
  assert.equal(parseToolCall(m[1]).tool, 'read_file');
});

test('unknown tool is rejected in pass-3 fallback', () => {
  // Unescaped quote breaks JSON.parse + pass-2 → pass-3 sees a bad tool name
  const raw = '{"tool":"delete_everything","path":"a"b"}';
  assert.throws(() => parseToolCall(raw), /unknown tool/);
});

test('missing tool field throws (pass 3)', () => {
  // Unescaped quote forces pass-3, which finds no tool field
  const raw = '{"path":"a"b"}';
  assert.throws(() => parseToolCall(raw), /tool field not found/);
});

test('markdown link is stripped from path', () => {
  assert.equal(stripMarkdownLink('[test.py](http://example.com)'), 'test.py');
  const call = sanitizeToolCall({ tool: 'read_file', path: '[a.ts](http://x)' });
  assert.equal(call.path, 'a.ts');
});

test('edit_file search/replace round-trip through pass 3', () => {
  const raw = '{"tool":"edit_file","path":"a.ts","search":"foo("bar")","replace":"baz"}';
  const call = parseToolCall(raw);
  assert.equal(call.tool, 'edit_file');
  assert.ok(call.search.includes('foo'));
});

test('TOOL_CALL_SCHEMA enumerates all tools plus "final"', () => {
  const e = TOOL_CALL_SCHEMA.properties.tool.enum;
  for (const t of TOOL_NAMES) assert.ok(e.includes(t), `schema enum missing ${t}`);
  assert.ok(e.includes('final'));
  assert.deepEqual(TOOL_CALL_SCHEMA.required, ['tool']);
});

test('sanitizeToolCall cleans a structured-output object', () => {
  const call = sanitizeToolCall({ tool: 'create_file', path: '[a.ts](http://x)', content: 'x' });
  assert.equal(call.path, 'a.ts');
});
