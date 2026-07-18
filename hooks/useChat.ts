import { logger } from '@/lib/logger';
import {
  useState,
  useEffect,
  useRef,
  useCallback,
  startTransition,
  type SetStateAction,
} from 'react';
import { resolveChatAttachmentAutoText } from '@/lib/chatAttachmentMessage';
import { getMimeTypeFromFileName } from '@/lib/fileUtils';
import { chatService, ChatMessage, ChatMessageActionError, UploadSessionOptions } from '@/services/chatService';
import { notificationService } from '@/services/notificationService';
import { chatCacheService, HydratedChatMessage } from '@/services/chatCacheService';
import { useAuth } from './useAuthUnified';
import { InteractionManager, Platform } from 'react-native';
import { getChatPaginationProfile } from '@/lib/chatPaginationConfig';
import { deriveRangeFromMessages } from '@/lib/chatHistoryPolicy';

export interface MessageWithAnimation extends ChatMessage {
  isNewMessage?: boolean;
}

type HydratedMessageState = HydratedChatMessage & { isNewMessage?: boolean };

interface SendChatTextMessageOptions {
  replyTo?: ChatMessage['replyTo'];
  // Stable client-generated identity threaded into the send payload so the
  // server upsert is idempotent across re-drives (stuck-message-delivery-fix).
  clientMsgId?: string;
}

function normalizeChatEmail(value?: string | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

const paginationProfile = getChatPaginationProfile(Platform.OS === 'web' ? 'web' : 'native');
const CHAT_PAGE_SIZE = paginationProfile.pageSize;
const CHAT_BOOTSTRAP_PAGES = paginationProfile.bootstrapPages;
const INITIAL_BOOTSTRAP_WINDOW = paginationProfile.bootstrapWindowSize;
const REALTIME_RECONCILE_PAGE_SIZE = paginationProfile.realtimeReconcileSize;

// Cap how many messages are retained in memory for the live view. Older
// messages remain persisted in the chat cache and are transparently reloaded
// by loadMore() when the user scrolls back up, so trimming only releases JS
// heap and keeps the list virtualizing a bounded dataset. The trim threshold
// sits well above the retain target so the window has hysteresis and does not
// thrash (trim -> immediate reload -> trim) while new messages stream in.
const MESSAGE_WINDOW_RETAIN_TARGET = Math.max(INITIAL_BOOTSTRAP_WINDOW * 3, 120);
const MESSAGE_WINDOW_TRIM_THRESHOLD = MESSAGE_WINDOW_RETAIN_TARGET + INITIAL_BOOTSTRAP_WINDOW * 2;

const takeLastN = <T>(items: T[], count: number): T[] => {
  if (!Array.isArray(items) || items.length === 0) return [];
  if (!count || items.length <= count) {
    return items.slice();
  }
  return items.slice(items.length - count);
};

const parseTimestampSafe = (value?: string): number => {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const findInsertionIndex = (messages: HydratedMessageState[], timestamp: string): number => {
  const target = parseTimestampSafe(timestamp);
  let low = 0;
  let high = messages.length;

  while (low < high) {
    const mid = (low + high) >>> 1;
    const midValue = parseTimestampSafe(messages[mid]?.timestamp);
    if (midValue <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
};

const normalizeMessageForState = (message: HydratedChatMessage | ChatMessage): HydratedMessageState => {
  const candidate = message as HydratedChatMessage;
  return {
    ...candidate,
    timestamp: candidate.timestamp || new Date().toISOString(),
    isNewMessage: false,
  } as HydratedMessageState;
};

/**
 * Compact signature of the mutable metadata of a message (edits, deletion,
 * and reactions).
 * Used to detect whether an already-known message actually changed while the
 * realtime listener was down, so reconcile can skip re-hydrating + updating
 * messages that are already in sync (the common case on every resume).
 */
const buildMessageMetaSignature = (
  message: { editCount?: number; editedAt?: string; deleted?: boolean; reactions?: Record<string, string[]> } | null | undefined
): string => {
  if (!message) return '';
  const editCount = typeof message.editCount === 'number' ? message.editCount : 0;
  const editedAt = typeof message.editedAt === 'string' ? message.editedAt : '';
  const deleted = message.deleted ? 1 : 0;
  // Include a lightweight reactions hash so reconcile can detect reaction-only
  // changes that happen while the realtime listener is down (e.g. app backgrounded).
  const reactions =
    message.reactions && typeof message.reactions === 'object'
      ? Object.entries(message.reactions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([type, users]) => `${type}:${Array.isArray(users) ? users.slice().sort().join(',') : ''}`)
          .join(';')
      : '';
  return `${editCount}|${editedAt}|${deleted}|${reactions}`;
};

export function useChat(recipientId?: string, options?: { live?: boolean }) {
  const liveEnabled = options?.live ?? true;
  const [messages, setMessages] = useState<HydratedMessageState[]>([]);
  // Mirror of `messages` for synchronous reads (e.g. window trimming) without
  // adding `messages` to callback dependency lists.
  const messagesRef = useRef<HydratedMessageState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [hasMore, setHasMore] = useState<boolean>(true);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const oldestCursorRef = useRef<string | null>(null);
  const cursorMetaRef = useRef<Map<string, { hasMore: boolean; oldestTimestamp: string | null }>>(new Map());
  const prefetchedPageRef = useRef<{
    cursor: string | null;
    page: ChatMessage[];
    normalized: HydratedMessageState[];
    hasMore: boolean;
    oldestTimestamp: string | null;
    persisted: boolean;
  } | null>(null);
  const prefetchPromiseRef = useRef<Promise<void> | null>(null);
  const hasMoreRef = useRef<boolean>(true);
  const { user } = useAuth();
  const previousMessageIds = useRef<Set<string>>(new Set());
  // Tracks the last-known mutable metadata signature per message id so reconcile
  // can skip messages that have not changed since we last saw them.
  const messageMetaSignatureRef = useRef<Map<string, string>>(new Map());
  // Tracks the source message object identity per id. Messages are treated
  // immutably (a changed message is a new object), so identity equality lets us
  // skip recomputing the signature for unchanged messages and keep the sync
  // O(changed) instead of O(total) on every update.
  const messageMetaSourceRef = useRef<Map<string, unknown>>(new Map());
  const hydrationAbortRef = useRef<Set<AbortController>>(new Set());
  const hasHydratedInitialWindowRef = useRef(false);
  const activeRecipientRef = useRef<string | null>(recipientId ?? null);
  const activeUserEmailRef = useRef<string | null>(user?.email ?? null);

  useEffect(() => {
    activeRecipientRef.current = recipientId ?? null;
  }, [recipientId]);

  useEffect(() => {
    activeUserEmailRef.current = user?.email ?? null;
  }, [user?.email]);

  const toExclusiveCursor = useCallback((timestamp?: string | null) => {
    if (!timestamp) {
      return null;
    }
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed)) {
      return timestamp;
    }
    const adjusted = parsed - 1;
    if (!Number.isFinite(adjusted) || adjusted <= 0) {
      return new Date(0).toISOString();
    }
    return new Date(adjusted).toISOString();
  }, []);
  const buildMessageKey = useCallback((message: Partial<ChatMessage> | HydratedChatMessage | HydratedMessageState | null | undefined): string => {
    if (!message) return '';
    if (message.id) {
      return String(message.id);
    }

    const rawSender = (message as any)?.sender;
    const rawRecipient = (message as any)?.recipientId;
    const sender = typeof rawSender === 'string' ? rawSender.toLowerCase() : '';
    const recipient = typeof rawRecipient === 'string' ? rawRecipient.toLowerCase() : '';

    let timestamp: string = '';
    const rawTimestamp = (message as any)?.timestamp;
    if (typeof rawTimestamp === 'string') {
      timestamp = rawTimestamp;
    } else if (rawTimestamp instanceof Date) {
      timestamp = rawTimestamp.toISOString();
    } else if (typeof rawTimestamp === 'number' && Number.isFinite(rawTimestamp)) {
      timestamp = new Date(rawTimestamp).toISOString();
    }

    const text = typeof (message as any)?.text === 'string' ? (message as any).text : '';
    const attachmentsSignature = Array.isArray((message as any)?.attachments)
      ? (message as any).attachments
          .map((attachment: any) => `${attachment?.url ?? ''}:${attachment?.fileName ?? ''}`)
          .join(',')
      : '';
    const gifUrl = typeof (message as any)?.gif?.url === 'string' ? (message as any).gif.url : '';
    const stickerUrl = typeof (message as any)?.sticker?.url === 'string' ? (message as any).sticker.url : '';

    return `${sender}|${recipient}|${timestamp}|${text}|${attachmentsSignature}|${gifUrl}|${stickerUrl}`;
  }, []);

  const beginHydration = useCallback(() => {
    const controller = new AbortController();
    hydrationAbortRef.current.add(controller);
    return controller;
  }, []);

  const finalizeHydration = useCallback((controller: AbortController) => {
    if (hydrationAbortRef.current.has(controller)) {
      hydrationAbortRef.current.delete(controller);
    }
  }, []);

  const isAbortError = useCallback((error: unknown) => {
    return (error as any)?.name === 'AbortError';
  }, []);

  useEffect(() => {
    hasMoreRef.current = hasMore;
  }, [hasMore]);

  // Keep the synchronous mirror of messages up to date.
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Keep the metadata signature map in sync with the rendered messages. This
  // runs after paint and lets reconcile cheaply detect unchanged messages.
  // The sync is incremental: signatures are only (re)computed for messages
  // whose underlying object identity changed since the last pass, and stale
  // entries are pruned. For large conversations this keeps the per-update cost
  // proportional to the number of changed messages rather than the total.
  useEffect(() => {
    const signatureMap = messageMetaSignatureRef.current;
    const sourceMap = messageMetaSourceRef.current;
    const seen = new Set<string>();

    for (const msg of messages) {
      if (!msg.id) {
        continue;
      }
      seen.add(msg.id);
      // Skip the expensive signature recompute when the object is unchanged.
      if (sourceMap.get(msg.id) === msg && signatureMap.has(msg.id)) {
        continue;
      }
      sourceMap.set(msg.id, msg);
      signatureMap.set(msg.id, buildMessageMetaSignature(msg));
    }

    // Drop entries for messages that are no longer present.
    if (signatureMap.size !== seen.size) {
      for (const id of signatureMap.keys()) {
        if (!seen.has(id)) {
          signatureMap.delete(id);
          sourceMap.delete(id);
        }
      }
    }
  }, [messages]);

  const isActiveConversation = useCallback(
    (userEmail?: string | null, peerId?: string | null) =>
      activeUserEmailRef.current === (userEmail ?? null) && activeRecipientRef.current === (peerId ?? null),
    []
  );

  const scheduleMessagesUpdate = useCallback((updater: () => void) => {
    const runUpdate = () => {
      if (typeof startTransition === 'function') {
        startTransition(() => {
          updater();
        });
      } else {
        updater();
      }
    };

    const canDefer = Platform.OS !== 'web' && typeof InteractionManager?.runAfterInteractions === 'function';
    if (canDefer) {
      InteractionManager.runAfterInteractions(() => {
        runUpdate();
      });
      return;
    }

    runUpdate();
  }, []);

  const applyMessagesUpdate = useCallback(
    (updater: SetStateAction<HydratedMessageState[]>, options?: { immediate?: boolean }) => {
      const runUpdate = () => {
        setMessages(updater);
      };

      if (options?.immediate) {
        runUpdate();
        return;
      }

      scheduleMessagesUpdate(runUpdate);
    },
    [scheduleMessagesUpdate]
  );

  const mergeOlderHydratedMessages = useCallback(
    (incoming: HydratedMessageState[]) => {
      if (!Array.isArray(incoming) || incoming.length === 0) {
        return;
      }

      applyMessagesUpdate((prev) => {
        if (!prev.length) {
          return incoming
            .map((msg) => ({ ...msg, isNewMessage: false }))
            .sort((a, b) => parseTimestampSafe(a.timestamp) - parseTimestampSafe(b.timestamp));
        }

        const existingKeys = new Set<string>();
        for (const msg of prev) {
          const key = buildMessageKey(msg);
          if (key) {
            existingKeys.add(key);
          }
        }

        const additions: HydratedMessageState[] = [];
        for (const msg of incoming) {
          const key = buildMessageKey(msg);
          if (!key || existingKeys.has(key)) {
            continue;
          }
          existingKeys.add(key);
          additions.push({ ...msg, isNewMessage: false });
        }

        if (!additions.length) {
          return prev;
        }

        const next = [...additions, ...prev];
        next.sort((a, b) => parseTimestampSafe(a.timestamp) - parseTimestampSafe(b.timestamp));
        return next;
      });
    },
    [applyMessagesUpdate, buildMessageKey]
  );

  const handleMediaCached = useCallback((remoteUrl: string, localUri: string) => {
    applyMessagesUpdate((prev) => {
      let changed = false;
      const next = prev.map((msg) => {
        let updated = false;
        let nextAttachments = msg.attachments;
        if (msg.attachments?.length) {
          let attachmentsUpdated = false;
          const enriched = msg.attachments.map((att) => {
            if (att.url === remoteUrl || att.resolvedUrl === remoteUrl) {
              if (att.resolvedUrl !== localUri) {
                attachmentsUpdated = true;
                return { ...att, resolvedUrl: localUri };
              }
            }
            return att;
          });
          if (attachmentsUpdated) {
            nextAttachments = enriched;
            updated = true;
          }
        }

        if (!updated) {
          return msg;
        }
        changed = true;
        return {
          ...msg,
          attachments: nextAttachments,
          localMediaAvailable: true,
        };
      });
      return changed ? next : prev;
    });
  }, [applyMessagesUpdate]);
  const triggerRemoteNotification = useCallback(async (message: ChatMessage, recipientEmail?: string) => {
    if (!recipientEmail) return;
    try {
      await notificationService.sendRemoteChatNotification(
        message,
        recipientEmail,
        user?.displayName || undefined
      );
    } catch (error) {
      logger.warn('Failed to send remote chat notification:', error);
    }
  }, [user?.displayName]);

  const handleMessageChange = useCallback(
    async (incoming: ChatMessage | null | undefined) => {
      if (!incoming?.id) {
        return;
      }
      if (!user?.email || !recipientId) {
        return;
      }

      previousMessageIds.current.add(incoming.id);

      await chatCacheService.appendMessages(user.email, recipientId, [incoming]).catch(() => undefined);

      const controller = beginHydration();
      let hydrated: HydratedChatMessage[] = [];
      try {
        hydrated = await chatCacheService.hydrateMessages(
          user.email,
          recipientId,
          [incoming],
          handleMediaCached,
          { signal: controller.signal }
        );
      } catch (error) {
        if (!isAbortError(error)) {
          logger.debug('chat.realtime.updateHydrateFailed', { error });
        }
      } finally {
        finalizeHydration(controller);
      }

      let nextMessage: HydratedMessageState;
      if (hydrated[0]) {
        nextMessage = { ...hydrated[0], isNewMessage: false } as HydratedMessageState;
      } else {
        nextMessage = {
          ...(incoming as HydratedChatMessage),
          timestamp: incoming.timestamp,
          attachments: incoming.attachments as any,
          localMediaAvailable: false,
          isNewMessage: false,
        } as HydratedMessageState;
      }

      const incomingMeta = incoming as {
        deleted?: boolean;
        deletedAt?: string;
        deletedBy?: string;
        editedAt?: string;
        editCount?: number;
        reactions?: Record<string, string[]>;
      };

      if (typeof incomingMeta.editCount === 'number') {
        nextMessage.editCount = incomingMeta.editCount;
      }
      if (typeof incomingMeta.editedAt === 'string') {
        nextMessage.editedAt = incomingMeta.editedAt;
      }
      // Explicitly apply reactions from the incoming payload onto nextMessage.
      // hydrateMessages resolves local media/cache and may return a copy that
      // pre-dates the reaction change, so – just like editCount/editedAt – we
      // must stamp the authoritative server value over whatever hydration returned.
      // A defined value (including `{}` for "all reactions removed") is always
      // used; an absent/undefined value leaves the hydrated copy untouched so
      // that unrelated updates (e.g. delivery ticks) don't wipe reactions.
      if (incomingMeta.reactions !== undefined) {
        (nextMessage as any).reactions = incomingMeta.reactions;
      }

      const isDeleted = Boolean(incomingMeta.deleted);

      if (isDeleted) {
        nextMessage.deleted = true;
        nextMessage.deletedAt = typeof incomingMeta.deletedAt === 'string' ? incomingMeta.deletedAt : nextMessage.deletedAt;
        nextMessage.deletedBy = typeof incomingMeta.deletedBy === 'string' ? incomingMeta.deletedBy : nextMessage.deletedBy;
        nextMessage.attachments = undefined;
        nextMessage.localMediaAvailable = false;
        if (!nextMessage.text) {
          nextMessage.text = '';
        }
      } else if (typeof incomingMeta.deleted === 'boolean' && !incomingMeta.deleted) {
        nextMessage.deleted = false;
        nextMessage.deletedAt = undefined;
        nextMessage.deletedBy = undefined;
      }

      applyMessagesUpdate((prev) => {
        const index = prev.findIndex((entry) => entry.id === incoming.id);
        if (index >= 0) {
          const next = [...prev];
          const existing = next[index];
          const merged: HydratedMessageState = {
            ...existing,
            ...nextMessage,
            isNewMessage: isDeleted ? false : existing.isNewMessage,
          };

          // Read receipts are monotonic: once a message is delivered/read it can
          // never regress. Cache hydration or an out-of-order realtime event can
          // otherwise carry a stale `read`/`delivered` flag and silently drop a
          // freshly applied double/blue tick — which is exactly the "tick does
          // not update in realtime" symptom. Reconcile the strongest known
          // status from the existing row, the raw incoming payload, and the
          // hydrated result so the tick only ever moves forward.
          const resolvedDeliveredAt =
            (incoming as ChatMessage).deliveredAt ||
            nextMessage.deliveredAt ||
            existing.deliveredAt;
          const resolvedReadAt =
            (incoming as ChatMessage).readAt ||
            nextMessage.readAt ||
            existing.readAt;
          const resolvedRead = Boolean(
            existing.read ||
              (incoming as ChatMessage).read ||
              nextMessage.read ||
              resolvedReadAt
          );
          const resolvedDelivered = Boolean(
            existing.delivered ||
              (incoming as ChatMessage).delivered ||
              nextMessage.delivered ||
              resolvedDeliveredAt ||
              resolvedRead
          );

          merged.delivered = resolvedDelivered;
          merged.read = resolvedRead;
          if (resolvedDeliveredAt) {
            merged.deliveredAt = resolvedDeliveredAt;
          }
          if (resolvedReadAt) {
            merged.readAt = resolvedReadAt;
          }

          next[index] = merged;
          return next;
        }

        const insertionIndex = findInsertionIndex(prev, nextMessage.timestamp || incoming.timestamp);
        const next = [...prev];
        next.splice(insertionIndex, 0, nextMessage);
        return next;
      });
    },
    [
      user?.email,
      recipientId,
      beginHydration,
      finalizeHydration,
      handleMediaCached,
      isAbortError,
      applyMessagesUpdate,
    ]
  );

  // Optimistically reflect that the local user has READ specific incoming
  // messages, without waiting for the backend receipt round-trip to echo back.
  //
  // The recipient's own "unread messages" divider is derived from each message's
  // `read` flag. If we only flip `read` when the server echoes the receipt,
  // the divider lingers for a full network round-trip (and the matching blue
  // tick on the sender appears at that same moment) — they are two symptoms of
  // the same delay. Flipping `read` locally the instant the message is actually
  // viewed clears the divider immediately; the receipt is still sent so the
  // sender's blue tick follows as the network allows. Monotonic by design:
  // already-read messages are never touched, so this can never regress state.
  const markMessagesReadLocally = useCallback((messageIds: Iterable<string>) => {
    const idSet = new Set<string>();
    for (const rawId of messageIds || []) {
      const id = rawId == null ? '' : String(rawId).trim();
      if (id) {
        idSet.add(id);
      }
    }
    if (idSet.size === 0) {
      return;
    }

    const readAt = new Date().toISOString();
    applyMessagesUpdate((prev) => {
      let changed = false;
      const next = prev.map((message) => {
        const id = message?.id != null ? String(message.id).trim() : '';
        if (!id || !idSet.has(id) || message.read) {
          return message;
        }
        changed = true;
        return {
          ...message,
          read: true,
          readAt: message.readAt || readAt,
          delivered: true,
          deliveredAt: message.deliveredAt || readAt,
        };
      });
      return changed ? next : prev;
    });
  }, [applyMessagesUpdate]);

  const prefetchNextPage = useCallback(
    (overrideCursor?: string | null, overrideHasMore?: boolean) => {
      if (!user?.email || !recipientId) {
        return;
      }
      const effectiveHasMore = overrideHasMore ?? hasMoreRef.current;
      if (!effectiveHasMore) {
        return;
      }
      if (prefetchPromiseRef.current || prefetchedPageRef.current) {
        return;
      }

      const cursor = overrideCursor ?? oldestCursorRef.current;
      if (!cursor) {
        return;
      }

      const requestUserEmail = user.email;
      const requestRecipientId = recipientId;
      const runner = async () => {
        try {
          const { messages: page, hasMore: hm, oldestTimestamp } = await chatService.fetchChatPage(
            user.email,
            recipientId,
            CHAT_PAGE_SIZE,
            cursor
          );

          let persisted = false;
          if (page.length) {
            try {
              await chatCacheService.saveConversation(user.email, recipientId, page, {
                hasMore: hm,
                oldestTimestamp,
              });
              persisted = true;
            } catch (saveError) {
              logger.debug('chat.prefetch.saveFailed', { saveError });
            }
          }

          let normalized: HydratedMessageState[] = [];
          if (page.length) {
            const controller = beginHydration();
            try {
              const hydrated = await chatCacheService.hydrateMessages(
                user.email,
                recipientId,
                page,
                handleMediaCached,
                { signal: controller.signal }
              );
              const source = hydrated.length ? hydrated : page;
              normalized = source.map((msg) => normalizeMessageForState(msg as HydratedChatMessage));
            } catch (hydrateError) {
              if (!isAbortError(hydrateError)) {
                logger.debug('Prefetch hydrate failed', { hydrateError });
              }
            } finally {
              finalizeHydration(controller);
            }
          }

          if (!isActiveConversation(requestUserEmail, requestRecipientId)) {
            return;
          }
          cursorMetaRef.current.set(cursor, { hasMore: hm, oldestTimestamp });
          prefetchedPageRef.current = {
            cursor,
            page,
            normalized,
            hasMore: hm,
            oldestTimestamp,
            persisted,
          };
          const attachmentsTarget = normalized.length ? normalized : page;
          chatCacheService.scheduleAttachmentPrefetch(attachmentsTarget);
        } catch (error) {
          logger.debug('Prefetching next chat page failed', { error });
        } finally {
          prefetchPromiseRef.current = null;
        }
      };

      prefetchPromiseRef.current = runner();
    },
    [
      user?.email,
      recipientId,
      beginHydration,
      finalizeHydration,
      handleMediaCached,
      isAbortError,
      isActiveConversation,
    ]
  );

  const warmNextPage = useCallback(() => {
    if (!user?.email || !recipientId) {
      return;
    }
    if (!hasMoreRef.current) {
      return;
    }
    const cursor = oldestCursorRef.current;
    if (!cursor) {
      return;
    }
    prefetchNextPage(cursor, hasMoreRef.current);
  }, [user?.email, recipientId, prefetchNextPage]);

  // Drop the oldest in-memory messages once the live window grows past the trim
  // threshold. The removed messages stay in the persistent chat cache, so
  // scrolling back up reloads them through loadMore()/getCachedPageBefore().
  // Callers must only invoke this when the viewport is parked at the bottom so
  // history the user is actively reading is never removed.
  const trimToRecentWindow = useCallback((): boolean => {
    const current = messagesRef.current;
    if (!Array.isArray(current) || current.length <= MESSAGE_WINDOW_TRIM_THRESHOLD) {
      return false;
    }

    let removed: HydratedMessageState[] = [];
    let retained: HydratedMessageState[] = [];

    applyMessagesUpdate((prev) => {
      if (prev.length <= MESSAGE_WINDOW_RETAIN_TARGET) {
        return prev;
      }

      const cut = prev.length - MESSAGE_WINDOW_RETAIN_TARGET;
      removed = prev.slice(0, cut);
      const kept = prev.slice(cut);
      retained = kept;
      const newOldest = kept[0];
      // Re-point pagination at the new in-memory boundary so the trimmed pages
      // reload from cache when the user scrolls back up.
      oldestCursorRef.current = toExclusiveCursor(newOldest?.timestamp ?? null);
      hasMoreRef.current = true;
      // A page prefetched relative to the previous (older) cursor is no longer
      // adjacent to the trimmed window; loadMore() also re-validates the cursor.
      prefetchedPageRef.current = null;
      prefetchPromiseRef.current = null;
      messagesRef.current = kept;
      return kept;
    }, { immediate: true });

    if (removed.length) {
      // Free the web blob object URLs held by the trimmed messages. They can no
      // longer render, and a later scroll-up reload re-hydrates them from the
      // persistent cache.
      chatCacheService.releaseInMemoryMedia(removed, retained);
      setHasMore(true);
      return true;
    }

    return false;
  }, [applyMessagesUpdate, toExclusiveCursor]);

  // Reset when chat partner changes
  useEffect(() => {
    // Free the previous conversation's in-memory media before discarding its
    // messages so blob object URLs do not accumulate across conversation
    // switches (web). The disk cache is preserved for fast re-entry.
    const previousMessages = messagesRef.current;
    if (Array.isArray(previousMessages) && previousMessages.length) {
      chatCacheService.releaseInMemoryMedia(previousMessages);
    }
    messagesRef.current = [];
    applyMessagesUpdate([], { immediate: true });
    setHasMore(true);
    setLoading(true);
    setError(null);
    oldestCursorRef.current = null;
    prefetchedPageRef.current = null;
    prefetchPromiseRef.current = null;
    hasMoreRef.current = true;
    previousMessageIds.current.clear();
    messageMetaSignatureRef.current.clear();
    hasHydratedInitialWindowRef.current = false;
  }, [recipientId, applyMessagesUpdate]);

  const hydrateCachedWindow = useCallback(async (): Promise<boolean> => {
    if (!user?.email || !recipientId) {
      return false;
    }

    try {
      const cached = await chatCacheService.getConversation(user.email, recipientId);
      const cachedMessages = Array.isArray(cached?.messages) ? cached.messages : [];
      const cachedWindow = takeLastN(cachedMessages, INITIAL_BOOTSTRAP_WINDOW);

      if (!cached || !cachedWindow.length) {
        if (cached) {
          setHasMore(Boolean(cached.hasMore));
          hasMoreRef.current = Boolean(cached.hasMore);
          oldestCursorRef.current = toExclusiveCursor(cached.oldestTimestamp);
        }
        return false;
      }

      const controller = beginHydration();
      let hydrated: HydratedChatMessage[] = [];
      try {
        hydrated = await chatCacheService.hydrateMessages(
          user.email,
          recipientId,
          cachedWindow,
          handleMediaCached,
          { signal: controller.signal }
        );
      } catch (hydrateError) {
        if (!isAbortError(hydrateError)) {
          logger.debug('Failed to hydrate cached conversation', { hydrateError });
        }
        hydrated = [];
      } finally {
        finalizeHydration(controller);
      }

      if (!hydrated.length) {
        return false;
      }

      const withFlags: HydratedMessageState[] = hydrated.map((msg) => {
        if (msg.id) {
          previousMessageIds.current.add(msg.id);
        }
        return normalizeMessageForState(msg);
      });

      applyMessagesUpdate(withFlags);
      hasHydratedInitialWindowRef.current = true;

      const bootstrapOldestTimestamp = cachedWindow[0]?.timestamp ?? cached.oldestTimestamp ?? null;
      const derivedHasMore = cached.hasMore || cachedWindow.length < cachedMessages.length;
      setHasMore(Boolean(derivedHasMore));
      hasMoreRef.current = Boolean(derivedHasMore);
      oldestCursorRef.current = toExclusiveCursor(bootstrapOldestTimestamp);
      chatCacheService.scheduleAttachmentPrefetch(withFlags);
      return true;
    } catch (error) {
      logger.debug('chat.bootstrap.cacheFailed', { error });
      return false;
    }
  }, [
    user?.email,
    recipientId,
    beginHydration,
    finalizeHydration,
    handleMediaCached,
    applyMessagesUpdate,
    toExclusiveCursor,
    isAbortError,
  ]);

  const syncLatestFromNetwork = useCallback(async (): Promise<void> => {
    if (!user?.email || !recipientId) {
      return;
    }

    const bootstrapPageSize = Math.max(INITIAL_BOOTSTRAP_WINDOW, CHAT_PAGE_SIZE * CHAT_BOOTSTRAP_PAGES);

    const { messages: page, hasMore: hm, oldestTimestamp } = await chatService.fetchChatPage(
      user.email,
      recipientId,
      bootstrapPageSize
    );

    if (!page.length) {
      setHasMore(Boolean(hm));
      hasMoreRef.current = Boolean(hm);
      oldestCursorRef.current = toExclusiveCursor(oldestTimestamp);
      return;
    }

    const conversation = await chatCacheService.saveConversation(user.email, recipientId, page, {
      hasMore: hm,
      oldestTimestamp,
    });

    const conversationMessages = Array.isArray(conversation.messages) && conversation.messages.length
      ? conversation.messages
      : page;

    const networkWindow = takeLastN(conversationMessages, INITIAL_BOOTSTRAP_WINDOW);
    if (!networkWindow.length) {
      setHasMore(Boolean(conversation.hasMore));
      hasMoreRef.current = Boolean(conversation.hasMore);
      oldestCursorRef.current = toExclusiveCursor(conversation.oldestTimestamp ?? oldestTimestamp ?? null);
      return;
    }

    const controller = beginHydration();
    let hydrated: HydratedChatMessage[] = [];
    try {
      hydrated = await chatCacheService.hydrateMessages(
        user.email,
        recipientId,
        networkWindow,
        handleMediaCached,
        { signal: controller.signal }
      );
    } catch (hydrateError) {
      if (!isAbortError(hydrateError)) {
        logger.debug('Failed to hydrate network conversation', { hydrateError });
      }
      hydrated = [];
    } finally {
      finalizeHydration(controller);
    }

    const normalized: HydratedMessageState[] = (hydrated.length ? hydrated : networkWindow).map((msg) => {
      const hydratedMessage = msg as HydratedChatMessage;
      if (hydratedMessage.id) {
        previousMessageIds.current.add(hydratedMessage.id);
      }
      return normalizeMessageForState(hydratedMessage);
    });

    applyMessagesUpdate(normalized);
    hasHydratedInitialWindowRef.current = true;

    const bootstrapOldestTimestamp = networkWindow[0]?.timestamp ?? conversation.oldestTimestamp ?? oldestTimestamp ?? null;
    const derivedHasMore = conversation.hasMore || conversationMessages.length > networkWindow.length;
    setHasMore(Boolean(derivedHasMore));
    hasMoreRef.current = Boolean(derivedHasMore);
    oldestCursorRef.current = toExclusiveCursor(bootstrapOldestTimestamp);
    chatCacheService.scheduleAttachmentPrefetch(normalized);

    if (derivedHasMore) {
      prefetchNextPage(toExclusiveCursor(bootstrapOldestTimestamp), derivedHasMore);
    }
  }, [
    user?.email,
    recipientId,
    beginHydration,
    finalizeHydration,
    handleMediaCached,
    applyMessagesUpdate,
    toExclusiveCursor,
    isAbortError,
    prefetchNextPage,
  ]);

  const reconnect = useCallback(() => {
    setError(null);
    setLoading(true);
    setReloadVersion((prev) => prev + 1);
  }, []);

  // Initial page and live tail
  useEffect(() => {
    let cancelled = false;
    const activeHydrationAbortControllers = hydrationAbortRef.current;

    const bootstrapConversation = async () => {
      if (!user?.email || !recipientId) {
        applyMessagesUpdate([], { immediate: true });
        setHasMore(false);
        hasMoreRef.current = false;
        setLoading(false);
        return;
      }

      setLoading(true);
      setError(null);

      const displayedCached = await hydrateCachedWindow();
      if (cancelled) {
        return;
      }

      try {
        await syncLatestFromNetwork();
      } catch (networkError) {
        if (!cancelled) {
          logger.warn('chat.bootstrap.networkFailed', { networkError });
          if (!displayedCached) {
            setError((networkError as Error)?.message || 'Failed to load messages');
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    bootstrapConversation();

    return () => {
      cancelled = true;
      activeHydrationAbortControllers.forEach((controller) => controller.abort());
      activeHydrationAbortControllers.clear();
    };
  }, [
    user?.email,
    recipientId,
    reloadVersion,
    hydrateCachedWindow,
    syncLatestFromNetwork,
    applyMessagesUpdate,
  ]);

  useEffect(() => {
    if (!user?.email || !recipientId || !liveEnabled) {
      return;
    }

    let cancelled = false;
    let realtimeCleanup: (() => void) | null = null;
    let fallbackCleanup: (() => void) | null = null;
    let reconcilePromise: Promise<void> | null = null;

    const processIncomingMessage = async (msg: ChatMessage) => {
      if (cancelled) {
        return;
      }

      if (msg.id && previousMessageIds.current.has(msg.id)) {
        return;
      }

      if (msg.id) {
        previousMessageIds.current.add(msg.id);
      }

      await chatCacheService.appendMessages(user.email, recipientId, [msg]).catch(() => undefined);
      if (cancelled) {
        return;
      }

      let hydrated: HydratedChatMessage[] = [];
      try {
        hydrated = await chatCacheService.hydrateMessages(
          user.email,
          recipientId,
          [msg],
          handleMediaCached
        );
      } catch (error) {
        if (!isAbortError(error)) {
          logger.debug('chat.realtime.hydrateFailed', { error });
        }
        hydrated = [];
      }

      if (cancelled) {
        return;
      }

      const nextMessage = hydrated[0];
      if (!nextMessage) {
        return;
      }

      applyMessagesUpdate((prev) => {
        if (nextMessage.id && prev.some((existing) => existing.id === nextMessage.id)) {
          return prev;
        }

        const enhanced: HydratedMessageState = { ...nextMessage, isNewMessage: true };
        if (!prev.length) {
          return [enhanced];
        }

        const insertionIndex = findInsertionIndex(prev, nextMessage.timestamp);
        const next = [...prev];
        next.splice(insertionIndex, 0, enhanced);
        return next;
      });

      if (!cancelled) {
        chatCacheService.scheduleAttachmentPrefetch([nextMessage]);
      }
    };

    const reconcileMissedMessages = async (): Promise<void> => {
      if (cancelled || reconcilePromise) {
        return await (reconcilePromise ?? Promise.resolve());
      }

      const runner = (async () => {
        try {
          const latestMeta = await chatService.getConversationLatestRecord(user.email, recipientId);
          if (!latestMeta?.messageId) {
            return;
          }

          const { messages: latestPage } = await chatService.fetchChatPage(
            user.email,
            recipientId,
            REALTIME_RECONCILE_PAGE_SIZE
          );

          if (!latestPage.length) {
            return;
          }

          for (const candidate of latestPage) {
            if (cancelled) {
              break;
            }
            if (!candidate?.id) {
              continue;
            }
            try {
              if (previousMessageIds.current.has(candidate.id)) {
                // Already known: only pay the hydrate + state-update cost if the
                // message actually changed (edited/deleted) while we were away.
                // This avoids a re-render storm on every resume for large
                // conversations where nothing changed.
                const signature = buildMessageMetaSignature(candidate);
                if (messageMetaSignatureRef.current.get(candidate.id) === signature) {
                  continue;
                }
                await handleMessageChange(candidate);
              } else {
                await processIncomingMessage(candidate);
              }
            } catch (error) {
              if (!cancelled) {
                logger.debug('chat.realtime.reconcileProcessFailed', { error, id: candidate?.id });
              }
            }
          }
        } catch (error) {
          if (!cancelled) {
            logger.debug('chat.realtime.reconcileFailed', { error });
          }
        } finally {
          reconcilePromise = null;
        }
      })();

      reconcilePromise = runner;
      await runner;
    };

    const subscribeRealtime = async () => {
      const cleanup = await chatService.subscribeToRealtimeConversation(user.email, recipientId, {
        onOpen: () => {
          void reconcileMissedMessages();
        },
        onMessage: (incoming) => {
          void processIncomingMessage(incoming);
        },
        onMessageUpdate: (incoming) => {
          void handleMessageChange(incoming);
        },
        onMessageDelete: (incoming) => {
          if (incoming) {
            void handleMessageChange({ ...incoming, deleted: true });
          }
        },
        onError: (error) => {
          logger.debug('chat.realtime.error', { error });
        },
      });

      if (cancelled) {
        cleanup?.();
        return;
      }

      if (cleanup) {
        realtimeCleanup = cleanup;
        await reconcileMissedMessages();
        return;
      }

      fallbackCleanup = chatService.onNewMessageForChat(user.email, recipientId, (incoming) => {
        void processIncomingMessage(incoming);
      });
      await reconcileMissedMessages();
    };

    void subscribeRealtime();

    const unsubscribeStatusChange = chatService.onChatMessageStatusChange(
      user.email,
      recipientId,
      (updatedMessage) => {
        if (!updatedMessage.id || cancelled) {
          return;
        }

        void handleMessageChange(updatedMessage);
      }
    );

    return () => {
      cancelled = true;
      realtimeCleanup?.();
      fallbackCleanup?.();
      unsubscribeStatusChange();
    };
  }, [
    user?.email,
    recipientId,
    liveEnabled,
    handleMediaCached,
    applyMessagesUpdate,
    isAbortError,
    handleMessageChange,
  ]);

  const loadMore = useCallback(async (options?: { aggressive?: boolean; force?: boolean }): Promise<boolean> => {
    if (!user?.email || !recipientId) return false;
    const force = Boolean(options?.force);
    if (loadingMore || (!force && !hasMoreRef.current)) return false;

    const aggressive = Boolean(options?.aggressive);
    const requestUserEmail = user.email;
    const requestRecipientId = recipientId;

    const loadOlderFromCache = async (expectedUserEmail: string, expectedRecipientId: string) => {
      if (!oldestCursorRef.current) {
        return { loaded: false, needsRemote: true } as const;
      }

      const cachedPage = await chatCacheService.getCachedPageBefore(
        user.email!,
        recipientId!,
        oldestCursorRef.current,
        CHAT_PAGE_SIZE
      );

      if (!cachedPage.messages.length) {
        const needsRemote = cachedPage.hasRemoteMore;
        return { loaded: false, needsRemote } as const;
      }

      const controller = beginHydration();
      let hydratedBatch: HydratedChatMessage[] = [];
      try {
        hydratedBatch = await chatCacheService.hydrateMessages(
          user.email!,
          recipientId!,
          cachedPage.messages,
          handleMediaCached,
          { signal: controller.signal }
        );
      } catch (hydrateError) {
        if (!isAbortError(hydrateError)) {
          logger.warn('Failed to hydrate cached page', hydrateError);
        }
        hydratedBatch = [];
      } finally {
        finalizeHydration(controller);
      }

      const normalizedBatch: HydratedMessageState[] = (hydratedBatch.length ? hydratedBatch : cachedPage.messages).map(
        (msg) => {
          const hydratedMessage = msg as HydratedChatMessage;
          if (hydratedMessage.id) {
            previousMessageIds.current.add(hydratedMessage.id);
          }
          return normalizeMessageForState(hydratedMessage);
        }
      );

      if (normalizedBatch.length) {
        if (!isActiveConversation(expectedUserEmail, expectedRecipientId)) {
          return { loaded: false, needsRemote: false } as const;
        }
        mergeOlderHydratedMessages(normalizedBatch);
        chatCacheService.scheduleAttachmentPrefetch(normalizedBatch);
      }

      const nextHasMore = cachedPage.hasMoreInCache || cachedPage.hasRemoteMore;
      if (!isActiveConversation(expectedUserEmail, expectedRecipientId)) {
        return { loaded: normalizedBatch.length > 0, needsRemote: cachedPage.hasRemoteMore && !cachedPage.hasMoreInCache } as const;
      }
      setHasMore(nextHasMore);
      hasMoreRef.current = nextHasMore;
      oldestCursorRef.current = toExclusiveCursor(cachedPage.oldestTimestamp);

      return {
        loaded: normalizedBatch.length > 0,
        needsRemote: cachedPage.hasRemoteMore && !cachedPage.hasMoreInCache,
      } as const;
    };

    if (aggressive) {
      prefetchedPageRef.current = null;
      prefetchPromiseRef.current = null;
    }

    setLoadingMore(true);
    try {
      const cacheAttempt = await loadOlderFromCache(requestUserEmail, requestRecipientId);
      if (cacheAttempt.loaded && !cacheAttempt.needsRemote) {
        return true;
      }

      if (cacheAttempt.loaded && cacheAttempt.needsRemote) {
        // continue to remote fetch within same call
      }

      if (prefetchPromiseRef.current) {
        if (!aggressive) {
          try {
            await prefetchPromiseRef.current;
          } catch (error) {
            if (!isAbortError(error)) {
              logger.debug('Prefetch failed prior to loadMore', { error });
            }
          }
        } else {
          prefetchPromiseRef.current = null;
        }
      }

      let prefetched = aggressive ? null : prefetchedPageRef.current;
      const expectedCursor = oldestCursorRef.current;

      if (prefetched && prefetched.cursor !== expectedCursor) {
        prefetched = null;
        prefetchedPageRef.current = null;
      }

      const pageSize = aggressive
        ? Math.min(CHAT_PAGE_SIZE * 2, REALTIME_RECONCILE_PAGE_SIZE)
        : CHAT_PAGE_SIZE;

      let page: ChatMessage[] = [];
      let pageHasMore = false;
      let oldestTimestamp: string | null = expectedCursor ?? null;
      let normalizedBatch: HydratedMessageState[] = [];
      let mergedDuringPrefetch = false;
      let prefetchedPersisted = false;

      if (prefetched) {
        prefetchedPageRef.current = null;
        page = prefetched.page;
        pageHasMore = prefetched.hasMore;
        oldestTimestamp = prefetched.oldestTimestamp ?? expectedCursor;
        prefetchedPersisted = Boolean(prefetched.persisted);

        if (Array.isArray(prefetched.normalized) && prefetched.normalized.length) {
          normalizedBatch = prefetched.normalized.map((msg) => ({ ...msg, isNewMessage: false }));
          for (const msg of normalizedBatch) {
            if (msg.id) {
              previousMessageIds.current.add(msg.id);
            }
          }
          if (!isActiveConversation(requestUserEmail, requestRecipientId)) {
            return false;
          }
          mergeOlderHydratedMessages(normalizedBatch);
          chatCacheService.scheduleAttachmentPrefetch(normalizedBatch);
          mergedDuringPrefetch = true;
        }
      } else {
        const result = await chatService.fetchChatPage(
          user.email,
          recipientId,
          pageSize,
          expectedCursor || undefined
        );
        page = result.messages;
        pageHasMore = result.hasMore ?? cursorMetaRef.current.get(expectedCursor ?? '')?.hasMore ?? false;
        oldestTimestamp = result.oldestTimestamp ?? cursorMetaRef.current.get(expectedCursor ?? '')?.oldestTimestamp ?? expectedCursor;
      }

      if (!page.length) {
        if (!isActiveConversation(requestUserEmail, requestRecipientId)) {
          return false;
        }
        setHasMore(pageHasMore);
        hasMoreRef.current = pageHasMore;
        oldestCursorRef.current = toExclusiveCursor(oldestTimestamp);
        if (pageHasMore) {
          prefetchNextPage(toExclusiveCursor(oldestTimestamp), pageHasMore);
        }
        return mergedDuringPrefetch && normalizedBatch.length > 0;
      }

      const pinRangeForRequest = deriveRangeFromMessages(page);

        if (!prefetchedPersisted) {
          await chatCacheService.saveConversation(user.email, recipientId, page, {
            hasMore: pageHasMore,
            oldestTimestamp,
            pinRange: pinRangeForRequest,
            pinMessages: page,
          });
        } else if (pinRangeForRequest) {
          await chatCacheService.pinHistoricalRange(user.email, recipientId, pinRangeForRequest, page);
        }

      if (!mergedDuringPrefetch) {
        const controller = beginHydration();
        let hydratedBatch: HydratedChatMessage[] = [];
        try {
          hydratedBatch = await chatCacheService.hydrateMessages(
            user.email,
            recipientId,
            page,
            handleMediaCached,
            { signal: controller.signal }
          );
        } catch (hydrateError) {
          if (!isAbortError(hydrateError)) {
            logger.warn('Failed to hydrate messages during loadMore', hydrateError);
          }
          hydratedBatch = [];
        } finally {
          finalizeHydration(controller);
        }

        normalizedBatch = (hydratedBatch.length ? hydratedBatch : page).map((msg) => {
          const hydratedMessage = msg as HydratedChatMessage;
          if (hydratedMessage.id) {
            previousMessageIds.current.add(hydratedMessage.id);
          }
          return normalizeMessageForState(hydratedMessage);
        });

        if (normalizedBatch.length) {
          if (!isActiveConversation(requestUserEmail, requestRecipientId)) {
            return false;
          }
          mergeOlderHydratedMessages(normalizedBatch);
          chatCacheService.scheduleAttachmentPrefetch(normalizedBatch);
        }
      }

      if (!isActiveConversation(requestUserEmail, requestRecipientId)) {
        return false;
      }
      setHasMore(pageHasMore);
      hasMoreRef.current = pageHasMore;
      oldestCursorRef.current = toExclusiveCursor(oldestTimestamp);

      if (pageHasMore) {
        prefetchNextPage(toExclusiveCursor(oldestTimestamp), pageHasMore);
      }

      return normalizedBatch.length > 0;
    } catch (e) {
      if (!isAbortError(e)) {
        logger.warn('Failed to load more messages', e);
      }
      return false;
    } finally {
      setLoadingMore(false);
    }
  }, [
    user?.email,
    recipientId,
    loadingMore,
    handleMediaCached,
    prefetchNextPage,
    beginHydration,
    finalizeHydration,
    isAbortError,
    mergeOlderHydratedMessages,
    toExclusiveCursor,
    isActiveConversation,
  ]);

  const sendMessage = async (
    text: string,
    isSpecial: boolean = false,
    recipientId?: string,
    options?: SendChatTextMessageOptions
  ): Promise<string> => {
    try {
      if (!user?.email) {
        throw new Error('User not authenticated');
      }

      // Self-address prevention (stuck-message-delivery-fix, Defect A / Property 3):
      // never let recipient resolution fall back to the sender. Reject before the
      // send so no self-conversation is ever created.
      if (recipientId && normalizeChatEmail(recipientId) === normalizeChatEmail(user.email)) {
        const err = new Error('You cannot send a message to yourself.');
        (err as any).selfAddressed = true;
        throw err;
      }

      const messageId = await chatService.sendMessage({
        text,
        sender: user.email,
        recipientId,
        clientMsgId: options?.clientMsgId,
        isSpecial,
        replyTo: options?.replyTo,
      });

      const timestamp = new Date().toISOString();
      try {
        await triggerRemoteNotification({
          id: messageId,
          text,
          sender: user.email,
          recipientId,
          timestamp,
          isSpecial,
          replyTo: options?.replyTo,
        } as ChatMessage, recipientId);
      } catch (notificationError) {
        // Message write already succeeded; don't fail UI send state for push issues.
        logger.warn('Chat notification dispatch failed after message send:', notificationError);
      }

      return messageId;
    } catch (err) {
      logger.error('Error in useChat sendMessage:', err);
      throw err; // Don't set error state, let the calling component handle it
    }
  };

  const sendSpecialMessage = async (text: string, recipientId?: string) => {
    try {
      if (!user?.email) {
        throw new Error('User not authenticated');
      }
      
      const messageId = await chatService.sendSpecialMessage(text, user.email, recipientId);

      const timestamp = new Date().toISOString();
      try {
        await triggerRemoteNotification({
          id: messageId,
          text,
          sender: user.email,
          recipientId,
          timestamp,
          isSpecial: true,
        } as ChatMessage, recipientId);
      } catch (notificationError) {
        logger.warn('Chat notification dispatch failed after special message send:', notificationError);
      }

      return messageId;
    } catch (err) {
      logger.error('Error in useChat sendSpecialMessage:', err);
      throw err; // Don't set error state, let the calling component handle it
    }
  };

  const sendMessageWithFile = async (
    text: string,
    fileUri: string,
    fileName: string,
    fileType: string,
    fileSize?: number,
    recipientId?: string,
    onProgress?: (progress: number) => void,
    options?: UploadSessionOptions & SendChatTextMessageOptions
  ) => {
    try {
      setError(null);
      if (!user?.email) {
        throw new Error('User not authenticated');
      }

      let cancelFn: (() => void | Promise<void>) | undefined;
      if (options?.registerCancel) {
        options.registerCancel(async () => {
          if (!cancelFn) {
            return;
          }
          try {
            await cancelFn();
          } catch (cancelError) {
            logger.warn('File upload cancel failed', cancelError);
          }
        });
      }

      const messageId = await chatService.sendMessageWithFile(
        text,
        fileUri,
        fileName,
        fileType,
        user.email,
        recipientId,
        onProgress,
        options?.registerCancel
          ? {
              registerCancel: (fn) => {
                cancelFn = fn;
              },
            }
          : undefined,
        options?.replyTo
      );
      const notificationText = resolveChatAttachmentAutoText({
        text,
        files: [{ fileType, fileName }],
      });

      const timestamp = new Date().toISOString();
      await triggerRemoteNotification({
        id: messageId,
        text: notificationText,
        sender: user.email,
        recipientId,
        timestamp,
        isSpecial: false,
        replyTo: options?.replyTo,
        attachments: [{
          url: '',
          fileName,
          fileType,
          fileSize: 0,
        }],
      } as ChatMessage, recipientId);
    } catch (err) {
      logger.error('Error in useChat sendMessageWithFile:', err);
      throw err; // Don't set error state, let the calling component handle it
    }
  };

  const sendMessageWithFiles = async (
    text: string,
    files: {
      uri: string;
      fileName: string;
      fileType: string;
      fileSize?: number;
      webFile?: Blob;
    }[],
    recipientId?: string,
    onProgress?: (progress: number) => void,
    options?: UploadSessionOptions & SendChatTextMessageOptions
  ): Promise<string> => {
    try {
      setError(null);
      if (!user?.email) {
        throw new Error('User not authenticated');
      }

      const cancelFns: ((() => void | Promise<void>) | undefined)[] = [];
      if (options?.registerCancel) {
        options.registerCancel(async () => {
          const executions = cancelFns
            .filter((fn): fn is (() => void | Promise<void>) => typeof fn === 'function')
            .map(async (fn) => {
              try {
                await fn();
              } catch (cancelError) {
                logger.warn('Attachment upload cancel function failed', cancelError);
              }
            });
          await Promise.allSettled(executions);
        });
      }

      const messageId = await chatService.sendMessageWithMultipleFiles(
        text,
        files,
        user.email,
        recipientId,
        onProgress,
        options?.registerCancel
          ? {
              registerCancel: (fn) => {
                cancelFns.push(fn);
              },
            }
          : undefined,
        options?.replyTo,
        options?.clientMsgId
      );
      const notificationText = resolveChatAttachmentAutoText({
        text,
        files,
      });

      const timestamp = new Date().toISOString();
      const attachments = files.map(file => ({
        url: '',
        fileName: file.fileName,
        fileType: file.fileType,
        fileSize: file.fileSize ?? 0,
      }));

      try {
        await triggerRemoteNotification({
          id: messageId,
          text: notificationText,
          sender: user.email,
          recipientId,
          timestamp,
          isSpecial: false,
          replyTo: options?.replyTo,
          attachments,
        } as ChatMessage, recipientId);
      } catch (notificationError) {
        logger.warn('Chat notification dispatch failed after attachment message send:', notificationError);
      }

      return messageId;
    } catch (err) {
      logger.error('Error in useChat sendMessageWithFiles:', err);
      throw err;
    }
  };

  const sendDocumentFile = async (
    text: string, 
    fileUri: string, 
    fileName: string, 
    recipientId?: string,
    options?: SendChatTextMessageOptions
  ) => {
    try {
      setError(null);
      if (!user?.email) {
        throw new Error('User not authenticated');
      }
      
      // Auto-detect mime type from file extension
      const mimeType = getMimeTypeFromFileName(fileName);
      const messageId = await chatService.sendMessageWithFile(
        text,
        fileUri,
        fileName,
        mimeType,
        user.email,
        recipientId,
        undefined,
        undefined,
        options?.replyTo
      );
      const notificationText = resolveChatAttachmentAutoText({
        text,
        files: [{ fileType: mimeType, fileName }],
      });

      const timestamp = new Date().toISOString();
      await triggerRemoteNotification({
        id: messageId,
        text: notificationText,
        sender: user.email,
        recipientId,
        timestamp,
        isSpecial: false,
        replyTo: options?.replyTo,
        attachments: [{
          url: '',
          fileName,
          fileType: mimeType,
          fileSize: 0,
        }],
      } as ChatMessage, recipientId);
    } catch (err) {
      logger.error('Error in useChat sendDocumentFile:', err);
      throw err;
    }
  };

  const sendAudioFile = async (
    text: string, 
    fileUri: string, 
    fileName: string, 
    recipientId?: string,
    options?: SendChatTextMessageOptions
  ) => {
    try {
      setError(null);
      if (!user?.email) {
        throw new Error('User not authenticated');
      }
      
      const mimeType = getMimeTypeFromFileName(fileName);
      const messageId = await chatService.sendMessageWithFile(
        text,
        fileUri,
        fileName,
        mimeType,
        user.email,
        recipientId,
        undefined,
        undefined,
        options?.replyTo
      );
      const notificationText = resolveChatAttachmentAutoText({
        text,
        files: [{ fileType: mimeType, fileName }],
      });

      const timestamp = new Date().toISOString();
      await triggerRemoteNotification({
        id: messageId,
        text: notificationText,
        sender: user.email,
        recipientId,
        timestamp,
        isSpecial: false,
        replyTo: options?.replyTo,
        attachments: [{
          url: '',
          fileName,
          fileType: mimeType,
          fileSize: 0,
        }],
      } as ChatMessage, recipientId);
    } catch (err) {
      logger.error('Error in useChat sendAudioFile:', err);
      throw err;
    }
  };

  const sendCodeFile = async (
    text: string, 
    fileUri: string, 
    fileName: string, 
    recipientId?: string,
    options?: SendChatTextMessageOptions
  ) => {
    try {
      setError(null);
      if (!user?.email) {
        throw new Error('User not authenticated');
      }
      
      const mimeType = getMimeTypeFromFileName(fileName);
      const messageId = await chatService.sendMessageWithFile(
        text,
        fileUri,
        fileName,
        mimeType,
        user.email,
        recipientId,
        undefined,
        undefined,
        options?.replyTo
      );
      const notificationText = resolveChatAttachmentAutoText({
        text,
        files: [{ fileType: mimeType, fileName }],
      });

      const timestamp = new Date().toISOString();
      await triggerRemoteNotification({
        id: messageId,
        text: notificationText,
        sender: user.email,
        recipientId,
        timestamp,
        isSpecial: false,
        replyTo: options?.replyTo,
        attachments: [{
          url: '',
          fileName,
          fileType: mimeType,
          fileSize: 0,
        }],
      } as ChatMessage, recipientId);
    } catch (err) {
      logger.error('Error in useChat sendCodeFile:', err);
      throw err;
    }
  };

  const sendMixedFiles = async (
    text: string, 
    files: {
      uri: string;
      fileName: string;
      detectedType?: string;
    }[],
    recipientId?: string,
    options?: SendChatTextMessageOptions
  ) => {
    try {
      setError(null);
      if (!user?.email) {
        throw new Error('User not authenticated');
      }
      
      const enrichedFiles = files.map(file => ({
        uri: file.uri,
        fileName: file.fileName,
        fileType: file.detectedType || getMimeTypeFromFileName(file.fileName),
      }));
      
      const messageId = await chatService.sendMessageWithMultipleFiles(
        text,
        enrichedFiles,
        user.email,
        recipientId,
        undefined,
        undefined,
        options?.replyTo,
        options?.clientMsgId
      );
      const notificationText = resolveChatAttachmentAutoText({
        text,
        files: enrichedFiles,
      });

      const timestamp = new Date().toISOString();
      const attachments = enrichedFiles.map(file => ({
        url: '',
        fileName: file.fileName,
        fileType: file.fileType,
        fileSize: 0,
      }));

      await triggerRemoteNotification({
        id: messageId,
        text: notificationText,
        sender: user.email,
        recipientId,
        timestamp,
        isSpecial: false,
        replyTo: options?.replyTo,
        attachments,
      } as ChatMessage, recipientId);
    } catch (err) {
      logger.error('Error in useChat sendMixedFiles:', err);
      throw err;
    }
  };

  const sendSticker = async (
    sticker: {
      url: string;
      name: string;
      pack?: string;
      width?: number;
      height?: number;
    },
    recipientId?: string,
    options?: SendChatTextMessageOptions
  ): Promise<string> => {
    try {
      setError(null);
      if (!user?.email) {
        throw new Error('User not authenticated');
      }
      
      const messageId = await chatService.sendSticker(sticker, user.email, recipientId, {
        replyTo: options?.replyTo,
        clientMsgId: options?.clientMsgId,
      });

      const timestamp = new Date().toISOString();
      try {
        await triggerRemoteNotification({
          id: messageId,
          text: '',
          sender: user.email,
          recipientId,
          timestamp,
          isSpecial: false,
          replyTo: options?.replyTo,
          sticker,
        } as ChatMessage, recipientId);
      } catch (notificationError) {
        logger.warn('Chat notification dispatch failed after sticker send:', notificationError);
      }

      return messageId;
    } catch (err) {
      logger.error('Error in useChat sendSticker:', err);
      throw err;
    }
  };

  const sendGif = async (
    gif: {
      url: string;
      thumbnailUrl?: string;
      width?: number;
      height?: number;
      title?: string;
      source?: string;
    },
    recipientId?: string,
    options?: SendChatTextMessageOptions
  ): Promise<string> => {
    try {
      setError(null);
      if (!user?.email) {
        throw new Error('User not authenticated');
      }
      
      const messageId = await chatService.sendGif(gif, user.email, recipientId, {
        replyTo: options?.replyTo,
        clientMsgId: options?.clientMsgId,
      });

      const timestamp = new Date().toISOString();
      try {
        await triggerRemoteNotification({
          id: messageId,
          text: '',
          sender: user.email,
          recipientId,
          timestamp,
          isSpecial: false,
          replyTo: options?.replyTo,
          gif,
        } as ChatMessage, recipientId);
      } catch (notificationError) {
        logger.warn('Chat notification dispatch failed after GIF send:', notificationError);
      }

      return messageId;
    } catch (err) {
      logger.error('Error in useChat sendGif:', err);
      throw err;
    }
  };

  const editExistingMessage = useCallback(
    async (messageId: string, text: string) => {
      if (!messageId) {
        throw new ChatMessageActionError('Message id is required', 'invalid_payload');
      }
      if (!user?.email) {
        throw new Error('User not authenticated');
      }

      try {
        setError(null);
        const updated = await chatService.editMessage(messageId, text);
        await handleMessageChange(updated);
        return updated;
      } catch (err) {
        logger.warn('chat.editMessage.failed', { messageId, err });
        throw err;
      }
    },
    [user?.email, handleMessageChange]
  );

  const deleteExistingMessage = useCallback(
    async (messageId: string) => {
      if (!messageId) {
        throw new ChatMessageActionError('Message id is required', 'invalid_payload');
      }
      if (!user?.email) {
        throw new Error('User not authenticated');
      }

      try {
        setError(null);
        const removed = await chatService.deleteMessage(messageId);
        await handleMessageChange(removed);
        return removed;
      } catch (err) {
        logger.warn('chat.deleteMessage.failed', { messageId, err });
        throw err;
      }
    },
    [user?.email, handleMessageChange]
  );

  return {
    messages,
    loading,
    error,
    reconnect,
    hasMore,
    loadingMore,
    loadMore,
    warmNextPage,
    trimToRecentWindow,
    sendMessage,
    sendMessageWithFile,
    sendSpecialMessage,
    sendMessageWithFiles,
    sendDocumentFile,
    sendAudioFile,
    sendCodeFile,
    sendMixedFiles,
    sendSticker,
    sendGif,
    editMessage: editExistingMessage,
    deleteMessage: deleteExistingMessage,
    markMessagesReadLocally,
  };
}