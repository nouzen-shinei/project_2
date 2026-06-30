/**
 * Single source of truth for "what was unread when this chat was opened".
 *
 * The unread-messages divider in a chat is a WhatsApp/Telegram-style marker that
 * is decided ONCE, at open time, and then pinned for the session. Two pieces of
 * information are captured:
 *   - `anchorMessageId`: the message the divider sits above (the first unread,
 *     or — when the precise message is not in the loaded window — a boundary
 *     derived from the unread count).
 *   - `count`: how many messages were unread on open (used for the label).
 *
 * The count prefers the ACCURATE live signal (loaded incoming messages whose
 * `read` flag is false) and only falls back to the conversation-summary /
 * roster badge counts when nothing unread is actually loaded — the badge counts
 * can lag or over-count, which would otherwise shift the count-based boundary
 * the divider sits at.
 *
 * Keeping this in one pure, tested function means the seeding logic lives in
 * exactly one place instead of being split across competing effects.
 */

export interface ChatUnreadDividerSeedInput {
  /** First loaded incoming message with read === false (already normalized id), or null. */
  firstUnreadMessageId?: string | null;
  /** Live count of loaded incoming messages that are unread. */
  incomingUnreadCount?: number;
  /** Loaded incoming conversation messages, oldest -> newest. */
  incomingConversationMessages?: ReadonlyArray<{ id?: unknown }>;
  /** Conversation-summary unread count (chat list badge), if known. */
  summaryUnreadCount?: unknown;
  /** Roster/team-member unread count, if known. */
  rosterUnreadCount?: unknown;
  normalizeMessageId: (value: unknown) => string;
}

export interface ChatUnreadDividerSeed {
  anchorMessageId: string | null;
  count: number;
}

function normalizeNonNegativeInt(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }
  return Math.trunc(numeric);
}

export function resolveChatUnreadDividerSeed(
  input: ChatUnreadDividerSeedInput
): ChatUnreadDividerSeed {
  const liveCount = normalizeNonNegativeInt(input.incomingUnreadCount);
  const summaryCount = normalizeNonNegativeInt(input.summaryUnreadCount);
  const rosterCount = normalizeNonNegativeInt(input.rosterUnreadCount);
  // Prefer the ACCURATE live count (actual loaded read:false incoming messages)
  // over the summary/roster badge counts, which can lag or over-count and would
  // otherwise shift the count-based boundary one (or more) messages too high.
  // Only fall back to the badge counts when nothing unread is loaded at all.
  const count = liveCount > 0 ? liveCount : Math.max(summaryCount, rosterCount);

  const firstUnread =
    typeof input.firstUnreadMessageId === 'string' && input.firstUnreadMessageId
      ? input.firstUnreadMessageId
      : '';

  let anchorMessageId: string | null = null;

  if (firstUnread) {
    // The precise first unread message is loaded — anchor directly to it.
    anchorMessageId = firstUnread;
  } else if (count > 0) {
    // No live unread message is loaded (e.g. the unread count came only from the
    // summary, or the unread messages are older than the loaded window). Fall
    // back to the boundary `count` messages from the end of the loaded incoming
    // messages, which approximates where the unread region begins.
    const messages = Array.isArray(input.incomingConversationMessages)
      ? input.incomingConversationMessages
      : [];
    if (messages.length > 0) {
      const clampedCount = Math.min(count, messages.length);
      const boundaryIndex = Math.max(0, messages.length - clampedCount);
      const boundaryId = input.normalizeMessageId(messages[boundaryIndex]?.id);
      anchorMessageId = boundaryId || null;
    }
  }

  return { anchorMessageId, count };
}
