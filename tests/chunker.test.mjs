import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chunkSource, cosine, topK, encodeVector, decodeVector, BINARY_EXT } = await import('../out/index/chunker.js');

test('module imports without vscode', () => {
  assert.equal(typeof chunkSource, 'function');
});

test('chunkSource windows with overlap', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
  const chunks = chunkSource(text, 40, 10);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].startLine, 1);
  assert.equal(chunks[0].endLine, 40);
  // step = 30 → next chunk starts at line 31
  assert.equal(chunks[1].startLine, 31);
  // last chunk ends at the final line
  assert.equal(chunks[chunks.length - 1].endLine, 100);
});

test('chunkSource skips empty input', () => {
  assert.deepEqual(chunkSource('   \n  \n'), []);
});

test('cosine of identical vectors is 1, orthogonal is 0', () => {
  const a = Float32Array.from([1, 0, 0]);
  const b = Float32Array.from([1, 0, 0]);
  const c = Float32Array.from([0, 1, 0]);
  assert.ok(Math.abs(cosine(a, b) - 1) < 1e-6);
  assert.ok(Math.abs(cosine(a, c)) < 1e-6);
});

test('topK ranks by similarity', () => {
  const q = Float32Array.from([1, 0]);
  const items = [
    { vector: Float32Array.from([0, 1]), id: 'orthogonal' },
    { vector: Float32Array.from([1, 0]), id: 'same' },
    { vector: Float32Array.from([0.7, 0.7]), id: 'mid' },
  ];
  const hits = topK(q, items, 2);
  assert.equal(hits[0].item.id, 'same');
  assert.equal(hits[1].item.id, 'mid');
});

test('vector base64 round-trip', () => {
  const v = Float32Array.from([0.5, -1.25, 3.0, 0]);
  const back = decodeVector(encodeVector(v));
  assert.equal(back.length, v.length);
  for (let i = 0; i < v.length; i++) assert.ok(Math.abs(back[i] - v[i]) < 1e-6);
});

test('BINARY_EXT matches binaries, not source', () => {
  assert.ok(BINARY_EXT.test('foo.png'));
  assert.ok(BINARY_EXT.test('bundle.min.js'));
  assert.ok(!BINARY_EXT.test('foo.ts'));
});
