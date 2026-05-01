export interface ChatConversationSearchMessage {
  id?: unknown;
  text?: unknown;
  sender?: unknown;
  senderName?: unknown;
  fileUrl?: unknown;
  fileName?: unknown;
  fileType?: unknown;
  attachments?: unknown;
  replyTo?: unknown;
  sticker?: unknown;
  gif?: unknown;
  deleted?: boolean;
}

export interface ChatConversationSearchHistoryLoadState {
  normalizedQuery: string;
  matchCount: number;
  hasMoreHistory: boolean;
  isLoadingHistory?: boolean;
}

export type ChatConversationSearchSnippetMatchType =
  | 'text'
  | 'attachment'
  | 'reply'
  | 'sticker'
  | 'gif'
  | 'file'
  | 'sender';

export type ChatConversationSearchScope =
  | 'all'
  | 'text'
  | 'attachment'
  | 'reply'
  | 'media';

export type ChatConversationSearchScopeMatchCounts = Record<ChatConversationSearchScope, number>;

export interface ChatConversationSearchScopeSuggestion {
  scope: ChatConversationSearchScope;
  count: number;
}

export type ChatConversationSearchScopeShortcutAction =
  | { type: 'step'; direction: 'next' | 'previous' }
  | { type: 'select-scope'; scope: ChatConversationSearchScope }
  | { type: 'best-suggestion' }
  | { type: 'suggestion-ordinal'; ordinal: number }
  | { type: 'suggestion-step'; direction: 'next' | 'previous' }
  | { type: 'load-more-history' }
  | { type: 'clear-query' }
  | { type: 'reset-all' };

const CHAT_CONVERSATION_SEARCH_SCOPE_SEQUENCE: readonly ChatConversationSearchScope[] = [
  'all',
  'text',
  'attachment',
  'reply',
  'media',
];

export interface ChatConversationSearchSnippet {
  messageId: string;
  matchType: ChatConversationSearchSnippetMatchType;
  beforeText: string;
  matchText: string;
  afterText: string;
}

interface ChatConversationSearchSourceCandidate {
  type: ChatConversationSearchSnippetMatchType;
  text: string;
}

type NormalizeMessageId = (value: unknown) => string | null;

function createEmptyScopeMatchCounts(): ChatConversationSearchScopeMatchCounts {
  return {
    all: 0,
    text: 0,
    attachment: 0,
    reply: 0,
    media: 0,
  };
}

function normalizeSearchText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizePositiveInteger(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return Math.trunc(numeric);
}

function normalizeMessageSnippetText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

function pushSearchSourceCandidate(
  seen: Set<string>,
  candidates: ChatConversationSearchSourceCandidate[],
  type: ChatConversationSearchSnippetMatchType,
  value: unknown
): void {
  const normalized = normalizeMessageSnippetText(value);
  if (!normalized) {
    return;
  }

  const dedupeKey = `${type}:${normalized.toLowerCase()}`;
  if (seen.has(dedupeKey)) {
    return;
  }

  seen.add(dedupeKey);
  candidates.push({
    type,
    text: normalized,
  });
}

function resolveMessageSearchSources(
  message: ChatConversationSearchMessage,
  scope: ChatConversationSearchScope = 'all'
): ChatConversationSearchSourceCandidate[] {
  if (!message || typeof message !== 'object') {
    return [];
  }

  const raw = message as Record<string, unknown>;
  const seen = new Set<string>();
  const candidates: ChatConversationSearchSourceCandidate[] = [];

  pushSearchSourceCandidate(seen, candidates, 'text', raw.text);
  pushSearchSourceCandidate(seen, candidates, 'reply', (raw.replyTo as Record<string, unknown> | undefined)?.text);
  pushSearchSourceCandidate(seen, candidates, 'reply', (raw.replyTo as Record<string, unknown> | undefined)?.senderName);

  if (Array.isArray(raw.attachments)) {
    for (const attachment of raw.attachments) {
      if (!attachment || typeof attachment !== 'object') {
        continue;
      }

      const rawAttachment = attachment as Record<string, unknown>;
      pushSearchSourceCandidate(seen, candidates, 'attachment', rawAttachment.fileName);
      pushSearchSourceCandidate(seen, candidates, 'attachment', rawAttachment.fileType);
      pushSearchSourceCandidate(seen, candidates, 'attachment', rawAttachment.url);
    }
  }

  if (raw.sticker && typeof raw.sticker === 'object') {
    const sticker = raw.sticker as Record<string, unknown>;
    pushSearchSourceCandidate(seen, candidates, 'sticker', sticker.name);
    pushSearchSourceCandidate(seen, candidates, 'sticker', sticker.pack);
  }

  if (raw.gif && typeof raw.gif === 'object') {
    const gif = raw.gif as Record<string, unknown>;
    pushSearchSourceCandidate(seen, candidates, 'gif', gif.title);
    pushSearchSourceCandidate(seen, candidates, 'gif', gif.source);
  }

  pushSearchSourceCandidate(seen, candidates, 'file', raw.fileName);
  pushSearchSourceCandidate(seen, candidates, 'file', raw.fileType);
  pushSearchSourceCandidate(seen, candidates, 'file', raw.fileUrl);
  pushSearchSourceCandidate(seen, candidates, 'sender', raw.senderName);
  pushSearchSourceCandidate(seen, candidates, 'sender', raw.sender);

  const normalizedScope = normalizeChatConversationSearchScope(scope);
  if (normalizedScope === 'all') {
    return candidates;
  }

  return candidates.filter((candidate) => {
    switch (normalizedScope) {
      case 'text':
        return candidate.type === 'text';
      case 'attachment':
        return candidate.type === 'attachment' || candidate.type === 'file';
      case 'reply':
        return candidate.type === 'reply';
      case 'media':
        return (
          candidate.type === 'attachment' ||
          candidate.type === 'sticker' ||
          candidate.type === 'gif' ||
          candidate.type === 'file'
        );
      default:
        return true;
    }
  });
}

function resolveMessageSearchText(
  message: ChatConversationSearchMessage,
  scope: ChatConversationSearchScope = 'all'
): string {
  const sources = resolveMessageSearchSources(message, scope);
  if (sources.length === 0) {
    return '';
  }

  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const source of sources) {
    const normalizedToken = normalizeSearchText(source.text);
    if (!normalizedToken || seen.has(normalizedToken)) {
      continue;
    }

    seen.add(normalizedToken);
    tokens.push(normalizedToken);
  }

  return tokens.join(' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildQueryMatcher(query: string): RegExp | null {
  const normalizedQuery = normalizeChatConversationSearchQuery(query);
  if (!normalizedQuery) {
    return null;
  }

  const pattern = escapeRegExp(normalizedQuery).replace(/\s+/g, '\\s+');
  if (!pattern) {
    return null;
  }

  try {
    return new RegExp(pattern, 'i');
  } catch {
    return null;
  }
}

export function normalizeChatConversationSearchQuery(value: unknown): string {
  return normalizeSearchText(value);
}

export function normalizeChatConversationSearchScope(value: unknown): ChatConversationSearchScope {
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

export function resolveChatConversationSearchScopeLabel(scope: unknown): string {
  switch (normalizeChatConversationSearchScope(scope)) {
    case 'text':
      return 'Text';
    case 'attachment':
      return 'Attachment';
    case 'reply':
      return 'Reply';
    case 'media':
      return 'Media';
    default:
      return 'All';
  }
}

export function resolveChatConversationSearchScopeStep(
  currentScope: unknown,
  direction: 'next' | 'previous'
): ChatConversationSearchScope {
  const normalizedScope = normalizeChatConversationSearchScope(currentScope);
  const currentIndex = CHAT_CONVERSATION_SEARCH_SCOPE_SEQUENCE.indexOf(normalizedScope);
  if (currentIndex < 0) {
    return 'all';
  }

  if (direction === 'previous') {
    const previousIndex =
      (currentIndex - 1 + CHAT_CONVERSATION_SEARCH_SCOPE_SEQUENCE.length) %
      CHAT_CONVERSATION_SEARCH_SCOPE_SEQUENCE.length;
    return CHAT_CONVERSATION_SEARCH_SCOPE_SEQUENCE[previousIndex];
  }

  const nextIndex = (currentIndex + 1) % CHAT_CONVERSATION_SEARCH_SCOPE_SEQUENCE.length;
  return CHAT_CONVERSATION_SEARCH_SCOPE_SEQUENCE[nextIndex];
}

export function resolveChatConversationSearchNoMatchesLabel(scope: unknown): string {
  switch (normalizeChatConversationSearchScope(scope)) {
    case 'text':
      return 'No text matches in this scope. Try All for broader results.';
    case 'attachment':
      return 'No attachment matches in this scope. Try filename-style queries.';
    case 'reply':
      return 'No reply matches in this scope. Try All for broader results.';
    case 'media':
      return 'No media matches in this scope. Try All for broader results.';
    default:
      return 'No matches yet. Try a different word.';
  }
}

export function resolveChatConversationSearchNoMatchesGuidance(
  scope: unknown,
  counts?: ChatConversationSearchScopeMatchCounts | null
): string {
  const normalizedScope = normalizeChatConversationSearchScope(scope);
  const fallbackScopes = resolveChatConversationSearchScopeSuggestions(counts || null, normalizedScope, 2);

  if (fallbackScopes.length === 1) {
    const topScope = fallbackScopes[0];
    return `Try ${resolveChatConversationSearchScopeLabel(topScope.scope)} (${topScope.count}).`;
  }

  if (fallbackScopes.length >= 2) {
    const firstScope = fallbackScopes[0];
    const secondScope = fallbackScopes[1];
    return `Try ${resolveChatConversationSearchScopeLabel(firstScope.scope)} (${firstScope.count}) or ${resolveChatConversationSearchScopeLabel(secondScope.scope)} (${secondScope.count}).`;
  }

  switch (normalizedScope) {
    case 'text':
      return 'Tip: try shorter phrases like "fee due" or "class moved".';
    case 'attachment':
      return 'Tip: try filename-style queries like "invoice_april.pdf" or "fee_receipt".';
    case 'reply':
      return 'Tip: try reply snippets like "as discussed" or "last reminder".';
    case 'media':
      return 'Tip: try media terms like "gif", "sticker", or "receipt.jpg".';
    default:
      return 'Tip: try shorter words or examples like "fee" or "invoice".';
  }
}

export function resolveChatConversationSearchSnippetTypeLabel(
  matchType: ChatConversationSearchSnippetMatchType
): string {
  switch (matchType) {
    case 'attachment':
      return 'Attachment';
    case 'reply':
      return 'Reply';
    case 'sticker':
      return 'Sticker';
    case 'gif':
      return 'GIF';
    case 'file':
      return 'File';
    case 'sender':
      return 'Sender';
    default:
      return 'Text';
  }
}

export function resolveChatConversationSearchSeedQuery(
  messageText: unknown,
  maxChars: number = 80,
  maxWords: number = 10
): string {
  const normalizedText = normalizeMessageSnippetText(messageText);
  if (!normalizedText) {
    return '';
  }

  const safeMaxWords = Math.max(2, Number.isFinite(maxWords) ? Math.trunc(maxWords) : 0);
  const safeMaxChars = Math.max(12, Number.isFinite(maxChars) ? Math.trunc(maxChars) : 0);

  const words = normalizedText.split(' ');
  const boundedByWords = words.slice(0, safeMaxWords).join(' ');
  if (boundedByWords.length <= safeMaxChars) {
    return boundedByWords;
  }

  return boundedByWords.slice(0, safeMaxChars).trimEnd();
}

export function resolveChatConversationSearchMatchIds(
  messages: ChatConversationSearchMessage[] | null | undefined,
  query: unknown,
  normalizeMessageId: NormalizeMessageId,
  scope: ChatConversationSearchScope = 'all'
): string[] {
  if (!Array.isArray(messages) || messages.length === 0 || typeof normalizeMessageId !== 'function') {
    return [];
  }

  const normalizedQuery = normalizeChatConversationSearchQuery(query);
  if (!normalizedQuery) {
    return [];
  }

  const seen = new Set<string>();
  const matches: string[] = [];

  for (const message of messages) {
    if (!message || message.deleted === true) {
      continue;
    }

    const normalizedMessageId = normalizeMessageId(message.id);
    if (!normalizedMessageId || seen.has(normalizedMessageId)) {
      continue;
    }

    const searchableText = resolveMessageSearchText(message, scope);
    if (!searchableText || !searchableText.includes(normalizedQuery)) {
      continue;
    }

    seen.add(normalizedMessageId);
    matches.push(normalizedMessageId);
  }

  return matches;
}

export function resolveChatConversationSearchScopeMatchCounts(
  messages: ChatConversationSearchMessage[] | null | undefined,
  query: unknown,
  normalizeMessageId: NormalizeMessageId
): ChatConversationSearchScopeMatchCounts {
  if (!Array.isArray(messages) || messages.length === 0 || typeof normalizeMessageId !== 'function') {
    return createEmptyScopeMatchCounts();
  }

  const normalizedQuery = normalizeChatConversationSearchQuery(query);
  if (!normalizedQuery) {
    return createEmptyScopeMatchCounts();
  }

  const counts = createEmptyScopeMatchCounts();
  const seenByScope: Record<ChatConversationSearchScope, Set<string>> = {
    all: new Set<string>(),
    text: new Set<string>(),
    attachment: new Set<string>(),
    reply: new Set<string>(),
    media: new Set<string>(),
  };

  for (const message of messages) {
    if (!message || message.deleted === true) {
      continue;
    }

    const normalizedMessageId = normalizeMessageId(message.id);
    if (!normalizedMessageId) {
      continue;
    }

    const matchedScopes: Record<ChatConversationSearchScope, boolean> = {
      all: false,
      text: false,
      attachment: false,
      reply: false,
      media: false,
    };

    const sourceCandidates = resolveMessageSearchSources(message, 'all');
    for (const candidate of sourceCandidates) {
      const normalizedCandidateText = normalizeSearchText(candidate.text);
      if (!normalizedCandidateText || !normalizedCandidateText.includes(normalizedQuery)) {
        continue;
      }

      matchedScopes.all = true;

      switch (candidate.type) {
        case 'text':
          matchedScopes.text = true;
          break;
        case 'reply':
          matchedScopes.reply = true;
          break;
        case 'attachment':
        case 'file':
          matchedScopes.attachment = true;
          matchedScopes.media = true;
          break;
        case 'sticker':
        case 'gif':
          matchedScopes.media = true;
          break;
        default:
          break;
      }
    }

    for (const scope of CHAT_CONVERSATION_SEARCH_SCOPE_SEQUENCE) {
      if (!matchedScopes[scope]) {
        continue;
      }

      const seenIds = seenByScope[scope];
      if (seenIds.has(normalizedMessageId)) {
        continue;
      }

      seenIds.add(normalizedMessageId);
      counts[scope] += 1;
    }
  }

  return counts;
}

export function resolveChatConversationSearchScopeSuggestions(
  counts: ChatConversationSearchScopeMatchCounts | null | undefined,
  activeScope: unknown,
  maxSuggestions: number = 3
): ChatConversationSearchScopeSuggestion[] {
  if (!counts || typeof counts !== 'object') {
    return [];
  }

  const normalizedActiveScope = normalizeChatConversationSearchScope(activeScope);
  const safeMaxSuggestions = Math.max(1, normalizePositiveInteger(maxSuggestions) || 3);
  const scopeOrder = CHAT_CONVERSATION_SEARCH_SCOPE_SEQUENCE;

  return scopeOrder
    .filter((scope) => scope !== normalizedActiveScope)
    .map((scope) => ({
      scope,
      count: normalizePositiveInteger((counts as Record<ChatConversationSearchScope, unknown>)[scope]),
    }))
    .filter((candidate) => candidate.count > 0)
    .sort((left, right) => {
      if (right.count !== left.count) {
        return right.count - left.count;
      }

      return scopeOrder.indexOf(left.scope) - scopeOrder.indexOf(right.scope);
    })
    .slice(0, safeMaxSuggestions);
}

export function resolveChatConversationSearchBestScopeSuggestion(
  counts: ChatConversationSearchScopeMatchCounts | null | undefined,
  activeScope: unknown
): ChatConversationSearchScopeSuggestion | null {
  const suggestions = resolveChatConversationSearchScopeSuggestions(counts, activeScope, 1);
  return suggestions.length > 0 ? suggestions[0] : null;
}

export function resolveChatConversationSearchScopeSuggestionByOrdinal(
  suggestions: ChatConversationSearchScopeSuggestion[] | null | undefined,
  ordinal: unknown
): ChatConversationSearchScopeSuggestion | null {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return null;
  }

  const safeOrdinal = normalizePositiveInteger(ordinal);
  if (safeOrdinal <= 0) {
    return null;
  }

  const targetIndex = safeOrdinal - 1;
  const targetSuggestion = suggestions[targetIndex];
  if (!targetSuggestion) {
    return null;
  }

  return targetSuggestion;
}

export function resolveChatConversationSearchScopeSuggestionCycle(
  suggestions: ChatConversationSearchScopeSuggestion[] | null | undefined,
  currentSuggestionScope: unknown,
  direction: 'next' | 'previous'
): ChatConversationSearchScopeSuggestion | null {
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    return null;
  }

  const normalizedCurrentScope =
    typeof currentSuggestionScope === 'string'
      ? normalizeChatConversationSearchScope(currentSuggestionScope)
      : null;
  const currentSuggestionIndex = normalizedCurrentScope
    ? suggestions.findIndex((suggestion) => suggestion?.scope === normalizedCurrentScope)
    : -1;

  if (currentSuggestionIndex < 0) {
    return direction === 'previous'
      ? suggestions[suggestions.length - 1] || null
      : suggestions[0] || null;
  }

  const stepOffset = direction === 'previous' ? -1 : 1;
  const nextIndex =
    (currentSuggestionIndex + stepOffset + suggestions.length) % suggestions.length;
  return suggestions[nextIndex] || null;
}

function resolveScopeSuggestionOrdinalFromShortcutKey(key: string, code: string): number {
  if (code === 'digit1' || code === 'numpad1' || key === '1' || key === '!') {
    return 1;
  }

  if (code === 'digit2' || code === 'numpad2' || key === '2' || key === '@') {
    return 2;
  }

  if (code === 'digit3' || code === 'numpad3' || key === '3' || key === '#') {
    return 3;
  }

  return 0;
}

function resolveScopeSelectionFromShortcutKey(
  key: string,
  code: string
): ChatConversationSearchScope | null {
  if (code === 'keya' || key === 'a') {
    return 'all';
  }

  if (code === 'keyt' || key === 't') {
    return 'text';
  }

  if (code === 'keyf' || key === 'f') {
    return 'attachment';
  }

  if (code === 'keyr' || key === 'r') {
    return 'reply';
  }

  if (code === 'keym' || key === 'm') {
    return 'media';
  }

  return null;
}

export function resolveChatConversationSearchScopeShortcutAction(input: {
  key?: unknown;
  code?: unknown;
  altKey?: boolean;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  hasMatches?: boolean;
  hasQuery?: boolean;
  hasMoreHistory?: boolean;
  isLoadingHistory?: boolean;
}): ChatConversationSearchScopeShortcutAction | null {
  const hasShortcutModifiers = input.altKey === true && input.shiftKey === true;
  if (!hasShortcutModifiers) {
    return null;
  }

  if (input.ctrlKey === true || input.metaKey === true) {
    return null;
  }

  const normalizedKey = typeof input.key === 'string' ? input.key.toLowerCase() : '';
  const normalizedCode = typeof input.code === 'string' ? input.code.toLowerCase() : '';
  const hasMatches = input.hasMatches === true;

  if (normalizedKey === 'arrowdown') {
    return { type: 'step', direction: 'next' };
  }

  if (normalizedKey === 'arrowup') {
    return { type: 'step', direction: 'previous' };
  }

  if (normalizedKey === 'arrowright') {
    return hasMatches ? null : { type: 'suggestion-step', direction: 'next' };
  }

  if (normalizedKey === 'arrowleft') {
    return hasMatches ? null : { type: 'suggestion-step', direction: 'previous' };
  }

  if (
    normalizedKey === 'backspace' ||
    normalizedCode === 'digit0' ||
    normalizedCode === 'numpad0' ||
    normalizedKey === '0' ||
    normalizedKey === ')'
  ) {
    return { type: 'reset-all' };
  }

  if (normalizedCode === 'keyx' || normalizedKey === 'x') {
    return { type: 'clear-query' };
  }

  if (normalizedCode === 'keyl' || normalizedKey === 'l') {
    if (input.hasQuery !== true || hasMatches || input.hasMoreHistory !== true || input.isLoadingHistory === true) {
      return null;
    }

    return { type: 'load-more-history' };
  }

  const selectedScope = resolveScopeSelectionFromShortcutKey(normalizedKey, normalizedCode);
  if (selectedScope) {
    return {
      type: 'select-scope',
      scope: selectedScope,
    };
  }

  if (normalizedKey === 'enter') {
    return hasMatches ? null : { type: 'best-suggestion' };
  }

  const suggestionOrdinal = resolveScopeSuggestionOrdinalFromShortcutKey(normalizedKey, normalizedCode);
  if (suggestionOrdinal <= 0 || hasMatches) {
    return null;
  }

  return {
    type: 'suggestion-ordinal',
    ordinal: suggestionOrdinal,
  };
}

export function clampChatConversationSearchIndex(index: number, totalMatches: number): number {
  const safeTotalMatches = normalizePositiveInteger(totalMatches);
  if (safeTotalMatches <= 0) {
    return -1;
  }

  const safeIndex = Number.isFinite(index) ? Math.trunc(index) : 0;
  if (safeIndex <= 0) {
    return 0;
  }

  if (safeIndex >= safeTotalMatches) {
    return safeTotalMatches - 1;
  }

  return safeIndex;
}

export function resolveChatConversationSearchCounterLabel(input: {
  normalizedQuery: unknown;
  matchCount: unknown;
  activeIndex: unknown;
  isLoadingHistory?: boolean;
}): string {
  const normalizedQuery = normalizeChatConversationSearchQuery(input.normalizedQuery);
  if (!normalizedQuery) {
    return '';
  }

  const safeMatchCount = normalizePositiveInteger(input.matchCount);
  if (safeMatchCount <= 0) {
    return input.isLoadingHistory === true ? 'Searching...' : '0/0';
  }

  const resolvedActiveIndex = clampChatConversationSearchIndex(
    Number(input.activeIndex),
    safeMatchCount
  );

  return `${Math.max(0, resolvedActiveIndex) + 1}/${safeMatchCount}`;
}

export function resolveChatConversationSearchNextIndex(
  currentIndex: number,
  totalMatches: number,
  direction: 'next' | 'previous'
): number {
  const safeTotalMatches = normalizePositiveInteger(totalMatches);
  if (safeTotalMatches <= 0) {
    return -1;
  }

  const baseIndex = clampChatConversationSearchIndex(currentIndex, safeTotalMatches);
  const safeBaseIndex = baseIndex < 0 ? 0 : baseIndex;

  if (direction === 'previous') {
    return (safeBaseIndex - 1 + safeTotalMatches) % safeTotalMatches;
  }

  return (safeBaseIndex + 1) % safeTotalMatches;
}

export function shouldLoadOlderForConversationSearch(state: ChatConversationSearchHistoryLoadState): boolean {
  const normalizedQuery = normalizeChatConversationSearchQuery(state.normalizedQuery);
  if (!normalizedQuery) {
    return false;
  }

  if (!state.hasMoreHistory || state.isLoadingHistory === true) {
    return false;
  }

  return normalizePositiveInteger(state.matchCount) <= 0;
}

export function resolveChatConversationSearchSnippet(
  messages: ChatConversationSearchMessage[] | null | undefined,
  matchIds: string[] | null | undefined,
  activeIndex: number,
  query: unknown,
  normalizeMessageId: NormalizeMessageId,
  maxContextChars: number = 38,
  scope: ChatConversationSearchScope = 'all'
): ChatConversationSearchSnippet | null {
  if (!Array.isArray(messages) || messages.length === 0) {
    return null;
  }

  if (!Array.isArray(matchIds) || matchIds.length === 0 || typeof normalizeMessageId !== 'function') {
    return null;
  }

  const clampedIndex = clampChatConversationSearchIndex(activeIndex, matchIds.length);
  if (clampedIndex < 0) {
    return null;
  }

  const targetMessageId = normalizeMessageId(matchIds[clampedIndex]);
  if (!targetMessageId) {
    return null;
  }

  const targetMessage = messages.find((message) => {
    if (!message || message.deleted === true) {
      return false;
    }

    return normalizeMessageId(message.id) === targetMessageId;
  });

  const matcher = buildQueryMatcher(typeof query === 'string' ? query : '');
  if (!matcher) {
    return null;
  }

  const sourceCandidates = resolveMessageSearchSources(targetMessage || {}, scope);
  if (sourceCandidates.length === 0) {
    return null;
  }

  let matchedCandidate: ChatConversationSearchSourceCandidate | null = null;
  let match: RegExpExecArray | null = null;
  for (const candidate of sourceCandidates) {
    const candidateMatch = matcher.exec(candidate.text);
    if (!candidateMatch || typeof candidateMatch.index !== 'number' || !candidateMatch[0]) {
      continue;
    }

    matchedCandidate = candidate;
    match = candidateMatch;
    break;
  }

  if (!matchedCandidate) {
    return null;
  }

  const sourceText = matchedCandidate.text;
  if (!match || typeof match.index !== 'number' || !match[0]) {
    return null;
  }

  const safeContextChars = Math.max(12, Math.trunc(maxContextChars));
  const matchStart = Math.max(0, match.index);
  const matchEnd = Math.min(sourceText.length, matchStart + match[0].length);

  const beforeStart = Math.max(0, matchStart - safeContextChars);
  const afterEnd = Math.min(sourceText.length, matchEnd + safeContextChars);

  const beforePrefix = beforeStart > 0 ? '...' : '';
  const afterSuffix = afterEnd < sourceText.length ? '...' : '';

  return {
    messageId: targetMessageId,
    matchType: matchedCandidate.type,
    beforeText: `${beforePrefix}${sourceText.slice(beforeStart, matchStart)}`,
    matchText: sourceText.slice(matchStart, matchEnd),
    afterText: `${sourceText.slice(matchEnd, afterEnd)}${afterSuffix}`,
  };
}
