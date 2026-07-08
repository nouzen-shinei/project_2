/**
 * Chat Reaction Utilities – pure functions and constants used across the
 * chat message rendering pipeline.
 *
 * Extracted from chat.tsx to reduce the file size and keep rendering logic
 * focused.  All helpers here are pure (no side-effects, no hooks) so they
 * can be safely called from anywhere.
 */

/** Standard set of quick-reaction emojis shown in the reaction picker */
export const QUICK_REACTIONS = ['❤️', '😂', '😮', '😢', '😡', '👍'] as const;

export type QuickReaction = (typeof QUICK_REACTIONS)[number];

/**
 * Normalise raw reaction data from the server into a shape suitable for
 * rendering by MessageReactionPills.
 *
 * The server may store reactions as:
 *   { [emoji]: Set<userId> }  or  { [emoji]: string[] }
 *
 * This helper handles both and always returns an array of pill descriptors.
 */
export interface ReactionPillDescriptor {
  emoji: string;
  count: number;
  users: string[];
  hasUserReacted: boolean;
}

export function normalizeReactions(
  raw: { [key: string]: Set<string> | string[] } | undefined | null,
  currentUserId: string | undefined
): ReactionPillDescriptor[] {
  if (!raw) return [];

  const pills: ReactionPillDescriptor[] = [];

  for (const [emoji, users] of Object.entries(raw)) {
    const userArr = users instanceof Set ? Array.from(users) : (users ?? []);
    if (userArr.length === 0) continue;

    pills.push({
      emoji,
      count: userArr.length,
      users: userArr,
      hasUserReacted: currentUserId ? userArr.includes(currentUserId) : false,
    });
  }

  return pills;
}

/**
 * Retrieve a displayable preview for a reply-to message.
 *
 * Truncates long text and falls back to a media label when the original
 * message only contained an image / sticker / GIF.
 */
export function getReplyPreviewText(
  message: any,
  maxLength = 60
): string {
  if (!message) return '';

  const text =
    message.text ?? message.content ?? message.body ?? '';

  if (text) {
    return text.length > maxLength ? text.slice(0, maxLength) + '…' : text;
  }

  // Fallback labels for media-only messages
  if (message.stickerUrl || message.stickerId) return '🎨 Sticker';
  if (message.gifUrl || message.gifId) return '🎬 GIF';
  if (message.imageUrl || message.mediaUrl) return '📷 Image';
  if (message.audioUrl) return '🎤 Voice message';

  return '';
}

/**
 * Compare two reaction maps for shallow equality.
 *
 * Used by memoization guards to skip re-renders when the reaction state
 * hasn't meaningfully changed.
 */
export function areReactionsEqual(
  a: { [key: string]: Set<string> } | undefined,
  b: { [key: string]: Set<string> } | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    const setA = a[key];
    const setB = b[key];
    if (!setB) return false;
    if (setA.size !== setB.size) return false;

    for (const userId of setA) {
      if (!setB.has(userId)) return false;
    }
  }

  return true;
}

/**
 * Get displayable emoji name for an emoji character
 */
export function getEmojiName(emoji: string): string {
  const emojiNames: { [key: string]: string } = {
    '❤️': 'heart',
    '😂': 'laugh',
    '😮': 'wow',
    '😢': 'sad',
    '😡': 'angry',
    '👍': 'like',
    '👎': 'dislike',
    '🔥': 'fire',
    '💯': 'hundred',
    '✨': 'sparkles',
    'heart': 'heart',
    'star': 'star',
    'smile': 'smile'
  };
  return emojiNames[emoji] || emoji;
}
