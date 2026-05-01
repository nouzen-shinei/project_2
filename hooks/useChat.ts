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
}

const paginationProfile = getChatPaginationProfile(Platform.OS === 'web' ? 'web' : 'native');
const CHAT_PAGE_SIZE = paginationProfile.pageSize;
const CHAT_BOOTSTRAP_PAGES = paginationProfile.bootstrapPages;
const INITIAL_BOOTSTRAP_WINDOW = paginationProfile.bootstrapWindowSize;
const REALTIME_RECONCILE_PAGE_SIZE = paginationProfile.realtimeReconcileSize;

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

export function useChat(recipientId?: string, options?: { live?: boolean }) {
  const liveEnabled = options?.live ?? true;
  const [messages, setMessages] = useState<HydratedMessageState[]>([]);
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
      };

      if (typeof incomingMeta.editCount === 'number') {
        nextMessage.editCount = incomingMeta.editCount;
      }
      if (typeof incomingMeta.editedAt === 'string') {
        nextMessage.editedAt = incomingMeta.editedAt;
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
          next[index] = {
            ...existing,
            ...nextMessage,
            isNewMessage: isDeleted ? false : existing.isNewMessage,
          };
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

  // Reset when chat partner changes
  useEffect(() => {
    applyMessagesUpdate([], { immediate: true });
    setHasMore(true);
    setLoading(true);
    setError(null);
    oldestCursorRef.current = null;
    prefetchedPageRef.current = null;
    prefetchPromiseRef.current = null;
    hasMoreRef.current = true;
    previousMessageIds.current.clear();
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
      
      const messageId = await chatService.sendMessage({
        text,
        sender: user.email,
        recipientId,
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
        options?.replyTo
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
        options?.replyTo
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
  };
}