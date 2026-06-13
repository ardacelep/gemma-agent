// Pure chat-session model: types, v1→v2 migration, caps, message derivation.
// MUST NOT import vscode (kept unit-testable).
import type { OllamaMessage } from '../llm/provider';

export type Entry =
  | { kind: 'user'; content: string; ts: number }
  | { kind: 'assistant'; content: string; ts: number }
  | { kind: 'tool'; tool: string; arg: string; ok: boolean; output: string; ts: number }
  | { kind: 'notice'; text: string; ts: number };

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  entries: Entry[];
}

export interface StoreV2 {
  version: 2;
  activeId: string;
  sessions: Session[];
}

export const MAX_SESSIONS = 20;
export const MAX_ENTRIES_PER_SESSION = 120;
export const MAX_SESSION_BYTES = 512 * 1024;
export const MAX_TOOL_OUTPUT_BYTES = 4 * 1024;
const DEFAULT_TITLE = 'New chat';

export function makeId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function autoTitle(text: string): string {
  const firstLine = (text || '').replace(/\s+/g, ' ').trim();
  if (!firstLine) return DEFAULT_TITLE;
  return firstLine.length > 40 ? firstLine.slice(0, 40) + '…' : firstLine;
}

export function newSession(title = DEFAULT_TITLE): Session {
  const now = Date.now();
  return { id: makeId(), title, createdAt: now, updatedAt: now, entries: [] };
}

export function isDefaultTitle(title: string): boolean {
  return !title || title === DEFAULT_TITLE;
}

/** LLM-facing history: only user/assistant entries become messages. */
export function entriesToMessages(entries: Entry[]): OllamaMessage[] {
  const out: OllamaMessage[] = [];
  for (const e of entries) {
    if (e.kind === 'user') out.push({ role: 'user', content: e.content });
    else if (e.kind === 'assistant') out.push({ role: 'assistant', content: e.content });
  }
  return out;
}

/** Cap a single session: trim tool outputs, then drop oldest entries to fit. */
export function capSession(session: Session): Session {
  let entries = session.entries.map((e) =>
    e.kind === 'tool' && e.output.length > MAX_TOOL_OUTPUT_BYTES
      ? { ...e, output: e.output.slice(0, MAX_TOOL_OUTPUT_BYTES) + '\n…(truncated)' }
      : e
  );
  if (entries.length > MAX_ENTRIES_PER_SESSION) {
    entries = entries.slice(-MAX_ENTRIES_PER_SESSION);
  }
  while (entries.length > 2 && JSON.stringify(entries).length > MAX_SESSION_BYTES) {
    entries = entries.slice(1);
  }
  return { ...session, entries };
}

/** Cap the whole store: at most MAX_SESSIONS, newest by updatedAt, each capped. */
export function capStore(store: StoreV2): StoreV2 {
  let sessions = store.sessions.map(capSession);
  if (sessions.length > MAX_SESSIONS) {
    sessions = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
  }
  const activeId = sessions.some((s) => s.id === store.activeId)
    ? store.activeId
    : sessions[0]?.id ?? '';
  return { version: 2, activeId, sessions };
}

interface V1Message { role: string; content: string; ts?: number }
interface V1Store { version: number; messages: V1Message[] }

/** Migrate the v1 single-conversation store into one Session. */
export function migrateV1(v1: unknown): Session | undefined {
  const store = v1 as V1Store | undefined;
  if (!store || store.version !== 1 || !Array.isArray(store.messages) || store.messages.length === 0) {
    return undefined;
  }
  const now = Date.now();
  const entries: Entry[] = [];
  for (const m of store.messages) {
    if ((m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string') {
      entries.push({ kind: m.role, content: m.content, ts: m.ts ?? now });
    }
  }
  if (entries.length === 0) return undefined;
  const firstUser = entries.find((e) => e.kind === 'user');
  const session = newSession(firstUser ? autoTitle(firstUser.content) : DEFAULT_TITLE);
  session.entries = entries;
  session.createdAt = entries[0].ts;
  session.updatedAt = entries[entries.length - 1].ts;
  return session;
}

/** Validate/normalize a loaded v2 store, or return undefined if unusable. */
export function parseStoreV2(raw: unknown): StoreV2 | undefined {
  const s = raw as StoreV2 | undefined;
  if (!s || s.version !== 2 || !Array.isArray(s.sessions)) return undefined;
  const sessions = s.sessions.filter(
    (x) => x && typeof x.id === 'string' && Array.isArray(x.entries)
  );
  if (sessions.length === 0) return undefined;
  return { version: 2, activeId: s.activeId, sessions };
}
