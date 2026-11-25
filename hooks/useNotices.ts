import { logger } from '@/lib/logger';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  addDoc,
  collection,
  doc,
  getCountFromServer,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  startAfter,
  Timestamp,
  updateDoc,
  where,
  type DocumentData,
  type DocumentSnapshot,
  type QueryConstraint,
  type QueryDocumentSnapshot,
  type UpdateData,
} from 'firebase/firestore';
import { firestore as db } from '../config/firebase';
import { useAuth, authService } from './useAuthUnified';
import { Notice, NoticeFormData } from '../types/notice';
import { noticeService } from '../services/noticeService';
import { useTenant } from './useTenantContext';
import type { TenantMembershipRole } from '../types/tenant';
import { noticeBackendClient } from '../services/noticeBackendClient';
import {
  countNoticeReactions,
  deriveNoticeIndexFields,
  normalizeTargetTenantRoles,
  ALL_NOTICE_ROLES,
} from '../lib/noticeIndexFields';
import { noticeEvents } from '../lib/noticeEvents';
import { noticeFilterConstraints, type NoticeFilter } from '../lib/noticeFilters';

/*
 * Notices data layer.
 *
 * Nothing here downloads the whole `notices` collection:
 *   - useNoticeFeed     the notice list, 20 at a time; the newest page is live.
 *   - useNoticeCounts   filter-chip / badge counts via Firestore count queries
 *                       (1 read per 1,000 matching notices), refreshed when
 *                       notices change.
 *   - useRecentNotices  live last-14-days notices for the startup popup.
 *   - useNoticeActions  writes (post, delete, view, react), no listeners.
 *
 * Every query is scoped to the tenant AND to notices the caller's role may
 * see (`visibleToRoles array-contains <role>`), which the security rules also
 * require.
 */

export const NOTICE_PAGE_SIZE = 20;
const RECENT_NOTICE_LIMIT = 50;
/** Counts fetched more recently than this aren't re-fetched on mount/foreground. */
const COUNT_FRESH_MS = 15_000;
/** Groups bursts of notice changes into one count refresh. */
const COUNT_REFRESH_DEBOUNCE_MS = 800;

type NoticeScope = { tenantId: string; role: TenantMembershipRole; uid: string };

const useNoticeScope = (): NoticeScope | null => {
  const { user } = useAuth();
  const { activeTenant, activeMembership } = useTenant();
  const tenantId = activeTenant?.id;
  const role = activeMembership?.role;
  const uid = user?.uid;
  return useMemo(
    () => (tenantId && role && uid ? { tenantId, role, uid } : null),
    [tenantId, role, uid],
  );
};

/** Bumps when the auth layer re-initialises Firestore, so listeners restart. */
const useFirestoreReinitKey = (): number => {
  const [reinitKey, setReinitKey] = useState(0);
  useEffect(() => {
    const unsubscribe = authService.registerFirestoreReinit?.(() => {
      setReinitKey((prev) => prev + 1);
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {}
    };
  }, []);
  return reinitKey;
};

const visibleNoticeConstraints = (scope: NoticeScope): QueryConstraint[] => [
  where('tenantId', '==', scope.tenantId),
  where('visibleToRoles', 'array-contains', scope.role),
];

const toIsoString = (value: unknown): string => {
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as Timestamp).toDate().toISOString();
  }
  return typeof value === 'string' ? value : '';
};

export const noticeFromSnapshot = (snap: DocumentSnapshot<DocumentData>): Notice => {
  // `estimate` gives a just-posted notice its local time instead of null until
  // the server timestamp lands, so it sorts at the top right away.
  const data = snap.data({ serverTimestamps: 'estimate' }) ?? {};
  return {
    ...(data as Omit<Notice, 'id'>),
    id: snap.id,
    createdAt: toIsoString(data.createdAt),
    updatedAt: data.updatedAt ? toIsoString(data.updatedAt) : undefined,
    tenantId: data.tenantId,
  } as Notice;
};

/** Same order as the queries: createdAt DESC, then document id DESC. */
const compareNewestFirst = (a: Notice, b: Notice): number => {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
};

const mergeLiveAndOlder = (live: Notice[], older: Notice[]): Notice[] => {
  const liveIds = new Set(live.map((n) => n.id));
  return [...live, ...older.filter((n) => !liveIds.has(n.id))].sort(compareNewestFirst);
};

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

/**
 * Notice list for one filter. The newest NOTICE_PAGE_SIZE notices come from a
 * live listener; `loadMore` appends older pages with one-time reads.
 *
 * When a new notice pushes the oldest live notice out of the live window, the
 * listener reports it as "removed". It is only treated as deleted if it isn't
 * older than everything left in a full window; otherwise it is kept as an
 * older (static) item so nothing disappears between pages.
 */
export function useNoticeFeed({ filter, enabled }: { filter: NoticeFilter; enabled: boolean }) {
  const scope = useNoticeScope();
  const reinitKey = useFirestoreReinitKey();
  const [live, setLive] = useState<Notice[]>([]);
  const [older, setOlder] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [loadMoreError, setLoadMoreError] = useState<Error | null>(null);

  const liveRef = useRef<Notice[]>([]);
  const olderRef = useRef<Notice[]>([]);
  const cursorsRef = useRef(new Map<string, QueryDocumentSnapshot<DocumentData>>());
  // Incremented on every (re)subscription so late results from an old
  // filter/tenant are ignored.
  const generationRef = useRef(0);
  const loadingMoreRef = useRef(false);

  const setOlderList = useCallback((next: Notice[]) => {
    olderRef.current = next;
    setOlder(next);
  }, []);

  const setLiveList = useCallback((next: Notice[]) => {
    liveRef.current = next;
    setLive(next);
  }, []);

  const feedConstraints = useMemo(
    () => (scope ? [...visibleNoticeConstraints(scope), ...noticeFilterConstraints(filter, scope.uid)] : null),
    [scope, filter],
  );

  useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setLiveList([]);
    setOlderList([]);
    cursorsRef.current = new Map();
    loadingMoreRef.current = false;
    setLoadingMore(false);
    setHasMore(false);
    setError(null);
    setLoadMoreError(null);

    if (!enabled || !feedConstraints) {
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    const liveQuery = query(
      collection(db, 'notices'),
      ...feedConstraints,
      orderBy('createdAt', 'desc'),
      limit(NOTICE_PAGE_SIZE),
    );
    let initial = true;

    const unsubscribe = onSnapshot(
      liveQuery,
      (snapshot) => {
        if (generation !== generationRef.current) return;
        const nextLive = snapshot.docs.map(noticeFromSnapshot);
        snapshot.docs.forEach((d) => cursorsRef.current.set(d.id, d));

        let setChanged = false;
        if (!initial) {
          const windowFull = snapshot.size >= NOTICE_PAGE_SIZE;
          const oldestLive = nextLive[nextLive.length - 1];
          let nextOlder = olderRef.current;

          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
              setChanged = true;
              return;
            }
            if (change.type !== 'removed') return;

            const removed = noticeFromSnapshot(change.doc);
            const pushedPastWindow =
              windowFull && oldestLive !== undefined && compareNewestFirst(removed, oldestLive) > 0;

            if (pushedPastWindow) {
              // Still exists. Keep it visible if older pages are already shown;
              // otherwise "Load more" will fetch it.
              if (nextOlder.length > 0 && !nextOlder.some((n) => n.id === removed.id)) {
                nextOlder = [removed, ...nextOlder].sort(compareNewestFirst);
              }
              return;
            }

            // Deleted, or no longer matches the filter.
            setChanged = true;
            cursorsRef.current.delete(removed.id);
            if (nextOlder.some((n) => n.id === removed.id)) {
              nextOlder = nextOlder.filter((n) => n.id !== removed.id);
            }
          });

          if (nextOlder !== olderRef.current) setOlderList(nextOlder);
        }

        setLiveList(nextLive);
        if (olderRef.current.length === 0) {
          setHasMore(snapshot.size >= NOTICE_PAGE_SIZE);
        }
        setLoading(false);
        if (!initial && setChanged) noticeEvents.emitChanged();
        initial = false;
      },
      (err) => {
        if (generation !== generationRef.current) return;
        logger.error('[useNoticeFeed] Error loading notices:', err);
        setError(err);
        setLoading(false);
      },
    );

    return () => unsubscribe();
  }, [enabled, feedConstraints, reinitKey, setLiveList, setOlderList]);

  const loadMore = useCallback(async () => {
    if (!feedConstraints || loadingMoreRef.current || !hasMore) return;
    const combined = mergeLiveAndOlder(liveRef.current, olderRef.current);
    const last = combined[combined.length - 1];
    const cursor = last ? cursorsRef.current.get(last.id) : undefined;
    if (!cursor) return;

    const generation = generationRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const page = await getDocs(
        query(
          collection(db, 'notices'),
          ...feedConstraints,
          orderBy('createdAt', 'desc'),
          startAfter(cursor),
          limit(NOTICE_PAGE_SIZE),
        ),
      );
      if (generation !== generationRef.current) return;
      page.docs.forEach((d) => cursorsRef.current.set(d.id, d));
      const liveIds = new Set(liveRef.current.map((n) => n.id));
      const knownIds = new Set(olderRef.current.map((n) => n.id));
      const additions = page.docs
        .map(noticeFromSnapshot)
        .filter((n) => !liveIds.has(n.id) && !knownIds.has(n.id));
      setOlderList([...olderRef.current, ...additions].sort(compareNewestFirst));
      setHasMore(page.size >= NOTICE_PAGE_SIZE);
    } catch (err) {
      if (generation !== generationRef.current) return;
      logger.warn('[useNoticeFeed] Failed to load more notices:', err);
      setLoadMoreError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (generation === generationRef.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [feedConstraints, hasMore, setOlderList]);

  /** Drop a notice locally (e.g. right after this user deleted it). */
  const removeNotice = useCallback(
    (noticeId: string) => {
      cursorsRef.current.delete(noticeId);
      if (olderRef.current.some((n) => n.id === noticeId)) {
        setOlderList(olderRef.current.filter((n) => n.id !== noticeId));
      }
      if (liveRef.current.some((n) => n.id === noticeId)) {
        setLiveList(liveRef.current.filter((n) => n.id !== noticeId));
      }
    },
    [setLiveList, setOlderList],
  );

  /** Replace a notice with a fresher copy (older pages aren't live). */
  const updateLocalNotice = useCallback(
    (notice: Notice) => {
      if (olderRef.current.some((n) => n.id === notice.id)) {
        setOlderList(olderRef.current.map((n) => (n.id === notice.id ? notice : n)));
      }
      if (liveRef.current.some((n) => n.id === notice.id)) {
        setLiveList(liveRef.current.map((n) => (n.id === notice.id ? notice : n)));
      }
    },
    [setLiveList, setOlderList],
  );

  const notices = useMemo(() => mergeLiveAndOlder(live, older), [live, older]);

  return {
    notices,
    loading,
    loadingMore,
    hasMore,
    error,
    loadMoreError,
    loadMore,
    removeNotice,
    updateLocalNotice,
  };
}

/** Live copy of one notice while it's open (older list pages aren't live). */
export function useNoticeDocument(noticeId: string | null | undefined, enabled: boolean) {
  const reinitKey = useFirestoreReinitKey();
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    setNotice(null);
    if (!enabled || !noticeId) return undefined;
    const unsubscribe = onSnapshot(
      doc(db, 'notices', noticeId),
      (snap) => setNotice(snap.exists() ? noticeFromSnapshot(snap) : null),
      (err) => logger.warn('[useNoticeDocument] Failed to watch notice:', err),
    );
    return () => unsubscribe();
  }, [noticeId, enabled, reinitKey]);

  return notice;
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

type CountEntry = {
  value?: number;
  fetchedAt?: number;
  inflight?: Promise<void>;
  /** A change happened while a fetch was in flight; fetch again after it. */
  staleWhileInflight?: boolean;
};

// Shared by every useNoticeCounts instance (home badge + notice list) so the
// same count is fetched once and both stay in step.
const countEntries = new Map<string, CountEntry>();
const countSubscribers = new Set<() => void>();

const countKey = (scope: NoticeScope, filter: NoticeFilter): string =>
  [scope.tenantId, scope.role, filter === 'mine' ? scope.uid : '', filter].join('|');

const notifyCountSubscribers = () => {
  countSubscribers.forEach((listener) => listener());
};

const fetchNoticeCount = (scope: NoticeScope, filter: NoticeFilter, force: boolean): Promise<void> => {
  const key = countKey(scope, filter);
  const entry = countEntries.get(key) ?? {};

  if (entry.inflight) {
    if (force) countEntries.set(key, { ...entry, staleWhileInflight: true });
    return entry.inflight;
  }
  if (!force && entry.fetchedAt !== undefined && Date.now() - entry.fetchedAt < COUNT_FRESH_MS) {
    return Promise.resolve();
  }

  const inflight = (async () => {
    let value = entry.value;
    let fetchedAt = entry.fetchedAt;
    try {
      const snapshot = await getCountFromServer(
        query(collection(db, 'notices'), ...visibleNoticeConstraints(scope), ...noticeFilterConstraints(filter, scope.uid)),
      );
      value = snapshot.data().count;
      fetchedAt = Date.now();
    } catch (err) {
      // Offline or transient: keep the last known value.
      logger.warn('[useNoticeCounts] Count query failed', { filter, err });
    }
    const rerun = countEntries.get(key)?.staleWhileInflight === true;
    countEntries.set(key, { value, fetchedAt });
    notifyCountSubscribers();
    if (rerun) await fetchNoticeCount(scope, filter, true);
  })();

  countEntries.set(key, { ...entry, inflight, staleWhileInflight: false });
  return inflight;
};

/**
 * Exact counts for the given filters, from Firestore count queries. A count is
 * `undefined` until first loaded (or while offline with nothing cached).
 */
export function useNoticeCounts({ filters, enabled }: { filters: readonly NoticeFilter[]; enabled: boolean }) {
  const scope = useNoticeScope();
  const reinitKey = useFirestoreReinitKey();
  const filtersKey = filters.join(',');
  const [, setVersion] = useState(0);

  useEffect(() => {
    const listener = () => setVersion((v) => v + 1);
    countSubscribers.add(listener);
    return () => {
      countSubscribers.delete(listener);
    };
  }, []);

  const refresh = useCallback(
    (force = false): Promise<void> => {
      if (!enabled || !scope || !filtersKey) return Promise.resolve();
      const ids = filtersKey.split(',') as NoticeFilter[];
      return Promise.all(ids.map((id) => fetchNoticeCount(scope, id, force))).then(() => undefined);
    },
    [enabled, scope, filtersKey],
  );

  useEffect(() => {
    void refresh(reinitKey > 0);
  }, [refresh, reinitKey]);

  useEffect(() => {
    if (!enabled) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = noticeEvents.subscribe(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(true), COUNT_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled) return undefined;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh(false);
    });
    return () => subscription.remove();
  }, [enabled, refresh]);

  const counts: Partial<Record<NoticeFilter, number>> = {};
  if (scope) {
    filters.forEach((filter) => {
      const value = countEntries.get(countKey(scope, filter))?.value;
      if (value !== undefined) counts[filter] = value;
    });
  }

  return { counts, refresh };
}

// ---------------------------------------------------------------------------
// Recent notices (startup popup)
// ---------------------------------------------------------------------------

/** Live notices from the last `days` days (newest RECENT_NOTICE_LIMIT). */
export function useRecentNotices({ enabled, days = 14 }: { enabled: boolean; days?: number }) {
  const scope = useNoticeScope();
  const reinitKey = useFirestoreReinitKey();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!enabled || !scope) {
      setNotices([]);
      setLoading(false);
      return undefined;
    }
    setLoading(true);
    const cutoff = Timestamp.fromMillis(Date.now() - days * 24 * 60 * 60 * 1000);
    const recentQuery = query(
      collection(db, 'notices'),
      ...visibleNoticeConstraints(scope),
      where('createdAt', '>=', cutoff),
      orderBy('createdAt', 'desc'),
      limit(RECENT_NOTICE_LIMIT),
    );
    let initial = true;
    const unsubscribe = onSnapshot(
      recentQuery,
      (snapshot) => {
        setNotices(snapshot.docs.map(noticeFromSnapshot));
        setLoading(false);
        if (!initial && snapshot.docChanges().some((change) => change.type !== 'modified')) {
          noticeEvents.emitChanged();
        }
        initial = false;
      },
      (err) => {
        logger.error('[useRecentNotices] Error loading recent notices:', err);
        setLoading(false);
      },
    );
    return () => unsubscribe();
  }, [enabled, scope, days, reinitKey]);

  return { notices, loading };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function useNoticeActions() {
  const { user } = useAuth();
  const { activeTenant, activeMembership } = useTenant();
  const uid = user?.uid;
  const tenantId = activeTenant?.id;

  const addNotice = useCallback(
    async (noticeData: NoticeFormData): Promise<string> => {
      if (!user) throw new Error('User not authenticated');
      if (!tenantId) throw new Error('Select a coaching center before creating notices');

      const createdByRole: TenantMembershipRole = activeMembership?.role || 'member';
      const indexFields = deriveNoticeIndexFields({ ...noticeData, source: 'user' });
      const createdByName = user.displayName || user.email?.split('@')[0] || 'Unknown User';
      const createdByEmail = user.email || '';

      const newNotice = {
        ...noticeData,
        // Store the normalized audience; omitted (undefined) for "Everyone".
        targetTenantRoles: indexFields.roleRestricted ? indexFields.visibleToRoles : undefined,
        ...indexFields,
        tenantId,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        createdBy: user.uid,
        createdByRole,
        createdByName,
        createdByEmail,
        isActive: true,
        viewCount: 0,
        userViews: {},
        reactionCount: 0,
      };

      // Firestore rejects `undefined` field values, and optional form fields are
      // often left unset (targetTenantRoles for an "Everyone" notice,
      // audioDurationMs/audioFileSize when the picker can't read them). Leave
      // those fields out of the document instead.
      const noticeDoc = Object.fromEntries(
        Object.entries(newNotice).filter(([, value]) => value !== undefined),
      );

      const docRef = await addDoc(collection(db, 'notices'), noticeDoc);
      noticeEvents.emitChanged();

      const createdAtIso = new Date().toISOString();
      const targetAudience = Array.isArray(noticeData.targetAudience) && noticeData.targetAudience.length > 0
        ? [...noticeData.targetAudience]
        : ['all'];

      const dispatchNotice: Notice = {
        id: docRef.id,
        title: noticeData.title,
        content: noticeData.content,
        imageUrl: noticeData.imageUrl,
        audioUrl: noticeData.audioUrl,
        audioFileName: noticeData.audioFileName,
        audioFileSize: noticeData.audioFileSize,
        audioDurationMs: noticeData.audioDurationMs,
        audioStoragePath: noticeData.audioStoragePath,
        linkUrl: noticeData.linkUrl,
        linkTitle: noticeData.linkTitle,
        priority: noticeData.priority,
        createdAt: createdAtIso,
        createdBy: user.uid,
        createdByRole,
        createdByName,
        createdByEmail,
        updatedAt: createdAtIso,
        isActive: true,
        targetTenantRoles: newNotice.targetTenantRoles,
        targetAudience,
        tenantId,
        viewCount: 0,
        userViews: {},
        ...indexFields,
      };

      noticeService.notifyNewNotice(dispatchNotice).catch((error) => {
        logger.warn('[useNotices] Failed to dispatch notice notifications:', error);
      });

      return docRef.id;
    },
    [user, tenantId, activeMembership?.role],
  );

  /**
   * Edit a notice. Recomputes the index fields affected by the edit; changing
   * the audience also rewrites `visibleToRoles`/`roleRestricted`.
   */
  const updateNotice = useCallback(
    async (noticeId: string, updates: Partial<NoticeFormData>): Promise<void> => {
      if (!user) throw new Error('User not authenticated');
      if (!tenantId) throw new Error('Select a coaching center before updating notices');

      const patch: Record<string, unknown> = { ...updates, updatedAt: serverTimestamp() };
      if ('imageUrl' in updates) patch.hasImage = Boolean(updates.imageUrl?.trim());
      if ('audioUrl' in updates) patch.hasAudio = Boolean(updates.audioUrl?.trim());
      if ('linkUrl' in updates) patch.hasLink = Boolean(updates.linkUrl?.trim());
      if ('targetTenantRoles' in updates) {
        const restrictedTo = normalizeTargetTenantRoles(updates.targetTenantRoles);
        patch.targetTenantRoles = restrictedTo;
        patch.roleRestricted = restrictedTo.length > 0;
        patch.visibleToRoles = restrictedTo.length > 0 ? restrictedTo : [...ALL_NOTICE_ROLES];
      }
      const cleanPatch = Object.fromEntries(
        Object.entries(patch).filter(([, value]) => value !== undefined),
      ) as UpdateData<DocumentData>;

      await updateDoc(doc(db, 'notices', noticeId), cleanPatch);
      noticeEvents.emitChanged();
    },
    [user, tenantId],
  );

  const deleteNotice = useCallback(
    async (noticeId: string): Promise<void> => {
      if (!user) throw new Error('User not authenticated');
      if (!tenantId) throw new Error('Select a coaching center before deleting notices');

      // Server is the source of truth for delete permissions.
      await noticeBackendClient.deleteNotice({ tenantId, noticeId });
      noticeEvents.emitChanged();
    },
    [user, tenantId],
  );

  const markNoticeAsViewed = useCallback(
    async (noticeId: string): Promise<void> => {
      if (!uid || !tenantId) return;
      // Field-level increments: no read of the notice needed.
      await updateDoc(doc(db, 'notices', noticeId), {
        viewCount: increment(1),
        [`userViews.${uid}.count`]: increment(1),
        [`userViews.${uid}.lastViewed`]: Timestamp.now(),
      });
    },
    [uid, tenantId],
  );

  const toggleNoticeReaction = useCallback(
    async (params: { noticeId: string; reactionType: string }): Promise<void> => {
      if (!uid) throw new Error('User not authenticated');
      if (!tenantId) throw new Error('Select a coaching center before reacting to notices');

      const noticeId = params.noticeId;
      const reactionType = (params.reactionType || '').trim();
      if (!reactionType) throw new Error('Reaction type is required');
      if (reactionType.length > 32) throw new Error('Reaction type is too long');

      const noticeRef = doc(db, 'notices', noticeId);
      const userId = uid;

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(noticeRef);
        if (!snap.exists()) {
          throw new Error('Notice not found');
        }

        const data = snap.data() as any;
        const currentReactionsRaw = data?.reactions;
        const currentReactions: Record<string, string[]> =
          currentReactionsRaw && typeof currentReactionsRaw === 'object' && !Array.isArray(currentReactionsRaw)
            ? (currentReactionsRaw as Record<string, string[]>)
            : {};

        // One reaction per user: remove userId from any existing reaction first.
        let removedFrom: string | null = null;
        const nextReactions: Record<string, string[]> = {};

        for (const [type, rawUsers] of Object.entries(currentReactions)) {
          const users = Array.isArray(rawUsers) ? rawUsers.filter((v) => typeof v === 'string') : [];
          const hadUser = users.includes(userId);
          const filtered = hadUser ? users.filter((id) => id !== userId) : users;

          if (hadUser) {
            removedFrom = type;
          }

          const unique = Array.from(new Set(filtered));
          if (unique.length > 0) {
            nextReactions[type] = unique;
          }
        }

        // Tapping the reaction the user already had toggles it off.
        if (removedFrom !== reactionType) {
          const existing = Array.isArray(nextReactions[reactionType]) ? nextReactions[reactionType] : [];
          nextReactions[reactionType] = Array.from(new Set([...existing, userId]));
        }

        tx.update(noticeRef, {
          reactions: nextReactions,
          reactionCount: countNoticeReactions(nextReactions),
          updatedAt: serverTimestamp(),
        });
      });
    },
    [uid, tenantId],
  );

  return {
    addNotice,
    updateNotice,
    deleteNotice,
    markNoticeAsViewed,
    toggleNoticeReaction,
  };
}
