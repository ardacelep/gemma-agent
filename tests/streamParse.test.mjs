import { test } from 'node:test';
import assert from 'node:assert/strict';

const { feedLines, parseSseLine, openAiDelta, ollamaChatChunk } = await import('../out/llm/streamParse.js');

test('module imports without vscode', () => {
  assert.equal(typeof feedLines, 'function');
});

test('feedLines splits complete lines and keeps the partial remainder', () => {
  const a = feedLines('', 'line1\nline2\npar');
  assert.deepEqual(a.lines, ['line1', 'line2']);
  assert.equal(a.rest, 'par');
  const b = feedLines(a.rest, 'tial\n');
  assert.deepEqual(b.lines, ['partial']);
  assert.equal(b.rest, '');
});

test('feedLines is CRLF tolerant', () => {
  const r = feedLines('', 'a\r\nb\r\n');
  assert.deepEqual(r.lines, ['a', 'b']);
});

test('parseSseLine extracts data payload', () => {
  assert.deepEqual(parseSseLine('data: {"x":1}'), { data: '{"x":1}' });
  assert.deepEqual(parseSseLine('data: [DONE]'), { done: true });
  assert.deepEqual(parseSseLine(': comment'), {});
  assert.deepEqual(parseSseLine(''), {});
});

test('openAiDelta pulls choices[0].delta.content', () => {
  assert.equal(openAiDelta('{"choices":[{"delta":{"content":"hi"}}]}'), 'hi');
  assert.equal(openAiDelta('{"choices":[{"delta":{}}]}'), undefined);
  assert.equal(openAiDelta('not json'), undefined);
});

test('ollamaChatChunk pulls message.content and done', () => {
  assert.deepEqual(ollamaChatChunk('{"message":{"content":"hi"},"done":false}'), { content: 'hi', done: false });
  assert.deepEqual(ollamaChatChunk('{"done":true}'), { content: undefined, done: true });
  assert.deepEqual(ollamaChatChunk('garbage'), {});
});

test('SSE stream reassembled across chunk boundaries', () => {
  // Simulate a delta split mid-line across two network chunks
  let buf = '';
  const out = [];
  for (const chunk of ['data: {"choices":[{"delta":{"con', 'tent":"AB"}}]}\n', 'data: [DONE]\n']) {
    const fed = feedLines(buf, chunk);
    buf = fed.rest;
    for (const line of fed.lines) {
      const { data, done } = parseSseLine(line);
      if (done) continue;
      if (data) { const d = openAiDelta(data); if (d) out.push(d); }
    }
  }
  assert.deepEqual(out, ['AB']);
});
