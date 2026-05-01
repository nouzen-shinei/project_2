export type ChatConversationSearchScope =
  | 'all'
  | 'text'
  | 'attachment'
  | 'reply'
  | 'media';

export interface ChatConversationSearchContextSnapshot {
  visible: boolean;
  query: string;
  scope: ChatConversationSearchScope;
}

export interface PersistedChatConversationSearchContextEntry
  extends ChatConversationSearchContextSnapshot {
  updatedAt: number;
}

export type PersistedChatConversationSearchContextStore = Record<
  string,
  PersistedChatConversationSearchContextEntry
>;

export interface ChatConversationSearchContextStoreOptions {
  maxAgeMs?: number;
  maxEntries?: number;
  maxQueryLength?: number;
}

export const DEFAULT_CHAT_CONVERSATION_SEARCH_CONTEXT_MAX_AGE_MS =
  1000 * 60 * 60 * 24 * 21;
export const DEFAULT_CHAT_CONVERSATION_SEARCH_CONTEXT_MAX_ENTRIES = 120;
export const DEFAULT_CHAT_CONVERSATION_SEARCH_CONTEXT_MAX_QUERY_LENGTH = 180;

function normalizeChatConversationSearchScope(value: unknown): ChatConversationSearchScope {
  switch (value) {
    case 'text':
      return 'text';
    case 'attachment':
      return 'attachment';
    case 'reply':
      return 'reply';
    case 'media':
      return 'media';
    default:
      return 'all';
  }
}

function resolveNow(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return Date.now();
  }

  return Math.trunc(numeric);
}

function normalizeContextKey(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function normalizeQuery(value: unknown, maxQueryLength: number): string {
  if (typeof value !== 'string') {
    return '';
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.slice(0, maxQueryLength);
}

function resolveOptions(options?: ChatConversationSearchContextStoreOptions) {
  const maxAgeMs = Number.isFinite(options?.maxAgeMs)
    ? Math.max(0, Math.trunc(options?.maxAgeMs as number))
    : DEFAULT_CHAT_CONVERSATION_SEARCH_CONTEXT_MAX_AGE_MS;
  const maxEntries = Number.isFinite(options?.maxEntries)
    ? Math.max(1, Math.trunc(options?.maxEntries as number))
    : DEFAULT_CHAT_CONVERSATION_SEARCH_CONTEXT_MAX_ENTRIES;
  const maxQueryLength = Number.isFinite(options?.maxQueryLength)
    ? Math.max(12, Math.trunc(options?.maxQueryLength as number))
    : DEFAULT_CHAT_CONVERSATION_SEARCH_CONTEXT_MAX_QUERY_LENGTH;

  return {
    maxAgeMs,
    maxEntries,
    maxQueryLength,
  };
}

function normalizeSnapshot(
  input: unknown,
  maxQueryLength: number
): ChatConversationSearchContextSnapshot {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};

  return {
    visible: raw.visible === true,
    query: normalizeQuery(raw.query, maxQueryLength),
    scope: normalizeChatConversationSearchScope(raw.scope),
  };
}

function isDefaultSnapshot(snapshot: ChatConversationSearchContextSnapshot): boolean {
  return !snapshot.visible && snapshot.query.length <= 0 && snapshot.scope === 'all';
}

export function normalizePersistedConversationSearchContextStore(
  input: unknown,
  nowMs: number = Date.now(),
  options?: ChatConversationSearchContextStoreOptions
): PersistedChatConversationSearchContextStore {
  const { maxAgeMs, maxEntries, maxQueryLength } = resolveOptions(options);
  const now = resolveNow(nowMs);

  if (!input || typeof input !== 'object') {
    return {};
  }

  const entries: [
    string,
    PersistedChatConversationSearchContextEntry
  ][] = [];

  for (const [rawKey, rawValue] of Object.entries(input as Record<string, unknown>)) {
    const key = normalizeContextKey(rawKey);
    if (!key || !rawValue || typeof rawValue !== 'object') {
      continue;
    }

    const rawEntry = rawValue as Record<string, unknown>;
    const updatedAtCandidate = Number(rawEntry.updatedAt);
    if (!Number.isFinite(updatedAtCandidate) || updatedAtCandidate <= 0) {
      continue;
    }

    const updatedAt = Math.trunc(updatedAtCandidate);
    if (maxAgeMs > 0 && now - updatedAt > maxAgeMs) {
      continue;
    }

    const snapshot = normalizeSnapshot(rawEntry, maxQueryLength);
    if (isDefaultSnapshot(snapshot)) {
      continue;
    }

    entries.push([
      key,
      {
        ...snapshot,
        updatedAt,
      },
    ]);
  }

  entries.sort((left, right) => right[1].updatedAt - left[1].updatedAt);

  const normalized: PersistedChatConversationSearchContextStore = {};
  for (const [key, entry] of entries.slice(0, maxEntries)) {
    normalized[key] = entry;
  }

  return normalized;
}

export function readPersistedConversationSearchContext(
  store: unknown,
  contextKey: string,
  nowMs: number = Date.now(),
  options?: ChatConversationSearchContextStoreOptions
): ChatConversationSearchContextSnapshot | null {
  const normalizedStore = normalizePersistedConversationSearchContextStore(
    store,
    nowMs,
    options
  );
  const normalizedKey = normalizeContextKey(contextKey);
  if (!normalizedKey) {
    return null;
  }

  const entry = normalizedStore[normalizedKey];
  if (!entry) {
    return null;
  }

  return {
    visible: entry.visible,
    query: entry.query,
    scope: entry.scope,
  };
}

export function upsertPersistedConversationSearchContext(
  store: unknown,
  contextKey: string,
  snapshot: ChatConversationSearchContextSnapshot,
  nowMs: number = Date.now(),
  options?: ChatConversationSearchContextStoreOptions
): PersistedChatConversationSearchContextStore {
  const normalizedStore = normalizePersistedConversationSearchContextStore(
    store,
    nowMs,
    options
  );
  const normalizedKey = normalizeContextKey(contextKey);
  if (!normalizedKey) {
    return normalizedStore;
  }

  const { maxQueryLength } = resolveOptions(options);
  const normalizedSnapshot = normalizeSnapshot(snapshot, maxQueryLength);
  if (isDefaultSnapshot(normalizedSnapshot)) {
    if (normalizedStore[normalizedKey]) {
      delete normalizedStore[normalizedKey];
    }
    return normalizedStore;
  }

  const now = resolveNow(nowMs);
  const nextStore = {
    ...normalizedStore,
    [normalizedKey]: {
      ...normalizedSnapshot,
      updatedAt: now,
    },
  };

  return normalizePersistedConversationSearchContextStore(nextStore, now, options);
}
