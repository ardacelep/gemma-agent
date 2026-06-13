import { test } from 'node:test';
import assert from 'node:assert/strict';

const mod = await import('../out/providers/sessionStore.js');
const { migrateV1, entriesToMessages, autoTitle, capStore, capSession, parseStoreV2, newSession, MAX_SESSIONS } = mod;

test('module imports without vscode', () => {
  assert.equal(typeof migrateV1, 'function');
});

test('entriesToMessages keeps only user/assistant', () => {
  const entries = [
    { kind: 'user', content: 'hi', ts: 1 },
    { kind: 'tool', tool: 'read_file', arg: 'x', ok: true, output: 'data', ts: 2 },
    { kind: 'assistant', content: 'hello', ts: 3 },
    { kind: 'notice', text: 'trimmed', ts: 4 },
  ];
  assert.deepEqual(entriesToMessages(entries), [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('autoTitle truncates to 40 chars', () => {
  assert.equal(autoTitle('short question'), 'short question');
  assert.ok(autoTitle('x'.repeat(80)).length <= 41);
  assert.equal(autoTitle(''), 'New chat');
});

test('migrateV1 builds one session titled from first user message', () => {
  const v1 = { version: 1, savedAt: 1, messages: [
    { role: 'user', content: 'how do I sort an array', ts: 10 },
    { role: 'assistant', content: 'use .sort()', ts: 11 },
  ] };
  const s = migrateV1(v1);
  assert.ok(s);
  assert.equal(s.title, 'how do I sort an array');
  assert.equal(s.entries.length, 2);
  assert.equal(s.entries[0].kind, 'user');
});

test('migrateV1 rejects bad/empty input', () => {
  assert.equal(migrateV1(undefined), undefined);
  assert.equal(migrateV1({ version: 2 }), undefined);
  assert.equal(migrateV1({ version: 1, messages: [] }), undefined);
});

test('capStore enforces MAX_SESSIONS keeping newest', () => {
  const sessions = [];
  for (let i = 0; i < MAX_SESSIONS + 5; i++) {
    const s = newSession('s' + i);
    s.updatedAt = i; // older first
    sessions.push(s);
  }
  const out = capStore({ version: 2, activeId: sessions[sessions.length - 1].id, sessions });
  assert.equal(out.sessions.length, MAX_SESSIONS);
  // Newest (highest updatedAt) must survive
  assert.ok(out.sessions.some((s) => s.title === 's' + (MAX_SESSIONS + 4)));
  assert.ok(!out.sessions.some((s) => s.title === 's0'));
});

test('capSession truncates large tool output', () => {
  const s = newSession('t');
  s.entries = [{ kind: 'tool', tool: 'run_command', arg: 'x', ok: true, output: 'y'.repeat(10000), ts: 1 }];
  const out = capSession(s);
  assert.ok(out.entries[0].output.length < 10000);
  assert.ok(out.entries[0].output.endsWith('(truncated)'));
});

test('parseStoreV2 validates shape', () => {
  assert.equal(parseStoreV2(undefined), undefined);
  assert.equal(parseStoreV2({ version: 1 }), undefined);
  const valid = { version: 2, activeId: 'a', sessions: [{ id: 'a', title: 't', createdAt: 1, updatedAt: 1, entries: [] }] };
  assert.ok(parseStoreV2(valid));
});
