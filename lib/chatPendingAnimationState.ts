/**
 * Pending message animation state helpers
 * 
 * Pure deterministic logic for managing pending message animation values,
 * timing parameters, and animation cache lifecycle.
 * 
 * Separates animation configuration from React Native Animated API calls
 * to enable unit testing of cache and timing logic.
 */

export type AnimationDirection = 'incoming' | 'outgoing';

/**
 * Animation timing parameters for a given direction.
 * 
 * Returned by `resolveChatPendingRowAnimationTimings()` for use in
 * Animated.timing() configuration.
 */
export interface PendingRowAnimationTimings {
  enterOffset: number;
  enterScale: number;
  fadeDuration: number;
  slideDuration: number;
  scaleDuration: number;
}

export interface ChatPendingRowAnimationEntry<T> {
  opacity: T;
  translateX: T;
  scale: T;
  started: boolean;
}

/**
 * Resolves animation timing parameters based on direction (incoming vs outgoing).
 * 
 * Incoming (received) messages slide in from left with greater opacity fade.
 * Outgoing (sent) messages slide in from right with faster animations.
 */
export function resolveChatPendingRowAnimationTimings(
  direction: AnimationDirection = 'outgoing'
): PendingRowAnimationTimings {
  const isIncoming = direction === 'incoming';

  return {
    enterOffset: isIncoming ? -12 : 8,
    enterScale: isIncoming ? 0.985 : 0.99,
    fadeDuration: isIncoming ? 260 : 180,
    slideDuration: isIncoming ? 280 : 210,
    scaleDuration: isIncoming ? 220 : 170,
  };
}

/**
 * Default opacity value for pending message bubbles.
 * 
 * Used as the initial value when creating a new Animated.Value for bubble opacity.
 */
export const PENDING_MESSAGE_BUBBLE_OPACITY_DEFAULT = 0.7;

/**
 * Default opacity value for row animations.
 * 
 * Animations fade in from this value to 1 over fadeDuration.
 */
export const PENDING_ROW_ANIMATION_OPACITY_DEFAULT = 0;

/**
 * Target opacity for sent messages (more faded to indicate delivery).
 */
export const PENDING_MESSAGE_BUBBLE_OPACITY_SENT = 0.52;

/**
 * Resolves target opacity for a pending message bubble based on status.
 */
export function resolveChatPendingBubbleOpacityTarget(status?: string | null): number {
  return status === 'sent'
    ? PENDING_MESSAGE_BUBBLE_OPACITY_SENT
    : PENDING_MESSAGE_BUBBLE_OPACITY_DEFAULT;
}

/**
 * Returns true when bubble opacity should animate between statuses.
 */
export function shouldAnimateChatPendingBubbleOpacity(
  previousStatus?: string | null,
  nextStatus?: string | null
): boolean {
  if (!previousStatus) {
    return false;
  }
  return previousStatus !== nextStatus;
}

/**
 * Resolves bubble opacity transition duration by target status.
 */
export function resolveChatPendingBubbleOpacityDuration(status?: string | null): number {
  return status === 'sent' ? 170 : 120;
}

/**
 * Determines which cached pending bubble ids should be pruned.
 */
export function resolveChatInactivePendingBubbleOpacityIds(
  cachedIds: Iterable<string>,
  activeIds: Set<string>
): Set<string> {
  const inactiveIds = new Set<string>();
  for (const id of cachedIds) {
    if (!activeIds.has(id)) {
      inactiveIds.add(id);
    }
  }
  return inactiveIds;
}

/**
 * Resolves a pending bubble opacity cache entry, creating it on first access.
 */
export function resolveChatPendingBubbleOpacityEntry<T>(
  cache: Map<string, T>,
  tempId: string,
  createEntry: () => T
): T {
  let entry = cache.get(tempId);
  if (!entry) {
    entry = createEntry();
    cache.set(tempId, entry);
  }
  return entry;
}

/**
 * Resolves a pending row animation cache entry, creating it on first access.
 */
export function resolveChatPendingRowAnimationEntry<T>(
  cache: Map<string, ChatPendingRowAnimationEntry<T>>,
  rowKey: string,
  createValues: () => Pick<ChatPendingRowAnimationEntry<T>, 'opacity' | 'translateX' | 'scale'>
): ChatPendingRowAnimationEntry<T> {
  let entry = cache.get(rowKey);
  if (!entry) {
    const values = createValues();
    entry = {
      opacity: values.opacity,
      translateX: values.translateX,
      scale: values.scale,
      started: false,
    };
    cache.set(rowKey, entry);
  }
  return entry;
}

/**
 * Determines if an animation entry should have animations started.
 * 
 * Returns true if this is the first time the entry is being accessed
 * and animations have not yet been started.
 */
export function shouldStartPendingRowAnimation(entry?: { started?: boolean }): boolean {
  if (!entry) return false;
  return !entry.started;
}

/**
 * Marks an animation entry as having animations started.
 * 
 * Used to prevent re-starting animations on subsequent accesses.
 */
export function markPendingRowAnimationStarted(entry: { started?: boolean }): void {
  if (entry) {
    entry.started = true;
  }
}

/**
 * Builds a row animation cache key from item type and ID.
 * 
 * Used to uniquely identify animation entries in the cache map.
 * Format: `${itemType}:${tempId}`
 */
export function buildChatPendingRowAnimationKey(
  itemType: 'text' | 'media' | 'attachment',
  tempId: string
): string {
  return `${itemType}:${tempId}`;
}

/**
 * Extracts active animation keys from pending item maps.
 * 
 * Collects all keys that should currently have animation entries cached.
 * Returns a Set for efficient membership testing during pruning.
 */
export function resolveChatActivePendingAnimationKeys(input: {
  pendingTextIds?: Iterable<string>;
  pendingMediaIds?: Iterable<string>;
  pendingAttachmentIds?: Iterable<string>;
}): Set<string> {
  const activeKeys = new Set<string>();

  if (input.pendingTextIds) {
    for (const tempId of input.pendingTextIds) {
      activeKeys.add(buildChatPendingRowAnimationKey('text', tempId));
    }
  }

  if (input.pendingMediaIds) {
    for (const tempId of input.pendingMediaIds) {
      activeKeys.add(buildChatPendingRowAnimationKey('media', tempId));
    }
  }

  if (input.pendingAttachmentIds) {
    for (const tempId of input.pendingAttachmentIds) {
      activeKeys.add(buildChatPendingRowAnimationKey('attachment', tempId));
    }
  }

  return activeKeys;
}

/**
 * Determines which animation cache keys should be pruned.
 * 
 * Returns the set of keys that exist in the cache but are not in the active set,
 * indicating they should be removed to prevent unbounded cache growth.
 */
export function resolveChatInactivePendingAnimationKeys(
  cachedKeys: Set<string>,
  activeKeys: Set<string>
): Set<string> {
  const inactiveKeys = new Set<string>();

  for (const key of cachedKeys) {
    if (!activeKeys.has(key)) {
      inactiveKeys.add(key);
    }
  }

  return inactiveKeys;
}
