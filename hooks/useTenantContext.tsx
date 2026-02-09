import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Timestamp } from 'firebase/firestore';
import type {
  Tenant,
  TenantJoinRequest,
  TenantMembership,
  TenantMembershipStatusEvent,
  TenantNotificationPreferences,
} from '@/types';
import { tenantService } from '@/services/tenantService';
import { useAuth, authService } from './useAuthUnified';
import { logger } from '@/lib/logger';

interface TenantContextValue {
  memberships: TenantMembership[];
  tenants: Tenant[];
  activeTenant: Tenant | null;
  activeMembership: TenantMembership | null;
  loading: boolean;
  error: string | null;
  pendingMemberships: TenantMembership[];
  joinRequests: TenantJoinRequest[];
  selectTenant: (tenantId: string | null) => Promise<void>;
  refreshTenants: () => Promise<void>;
  applyTenantNotificationPreferencesSnapshot: (
    tenantId: string,
    prefs: TenantNotificationPreferences,
  ) => void;
}

const isFirestoreTimestamp = (value: unknown): value is Timestamp => {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'toDate' in (value as Record<string, unknown>) &&
      typeof (value as Timestamp).toDate === 'function',
  );
};

const normalizeStatusEventTimestamp = (value: unknown): string | null => {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    const asDate = new Date(value);
    return Number.isNaN(asDate.getTime()) ? null : asDate.toISOString();
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (isFirestoreTimestamp(value)) {
    try {
      return value.toDate().toISOString();
    } catch {
      return null;
    }
  }
  return null;
};

const getSortableTime = (iso: string): number => {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 0 : time;
};

const normalizeMembershipHistory = (membership: TenantMembership): TenantMembership => {
  const fallbackAt = membership.updatedAt || membership.createdAt || new Date().toISOString();
  const historySource = Array.isArray(membership.statusHistory) ? membership.statusHistory : [];
  const normalizedHistory = historySource
    .map((event) => {
      if (!event || typeof event !== 'object' || !event.status) {
        return null;
      }
      const normalizedAt = normalizeStatusEventTimestamp(event.at) || fallbackAt;
      const normalizedEvent: TenantMembershipStatusEvent = {
        status: event.status,
        at: normalizedAt,
      };
      if (event.actorId) {
        normalizedEvent.actorId = event.actorId;
      }
      if (event.actorEmail) {
        normalizedEvent.actorEmail = event.actorEmail;
      }
      if (event.actorName) {
        normalizedEvent.actorName = event.actorName;
      }
      if (event.reason) {
        normalizedEvent.reason = event.reason;
      }
      return normalizedEvent;
    })
    .filter((event): event is TenantMembershipStatusEvent => Boolean(event))
    .sort((a, b) => getSortableTime(b.at) - getSortableTime(a.at));

  const hasCurrentStatusEvent = normalizedHistory.some((event) => event.status === membership.status);
  if (!hasCurrentStatusEvent) {
    normalizedHistory.unshift({
      status: membership.status,
      at: fallbackAt,
    });
  }

  return {
    ...membership,
    statusHistory: normalizedHistory,
  };
};

const normalizeMembershipList = (list: TenantMembership[]): TenantMembership[] => {
  if (!Array.isArray(list) || !list.length) {
    return list;
  }
  return list.map((membership) => normalizeMembershipHistory(membership));
};

const TenantContext = createContext<TenantContextValue | undefined>(undefined);

export const TenantProvider = ({ children }: { children: React.ReactNode }) => {
  const { user } = useAuth();
  const [memberships, setMemberships] = useState<TenantMembership[]>([]);
  const [tenantMap, setTenantMap] = useState<Record<string, Tenant>>({});
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [loadingTenants, setLoadingTenants] = useState(false);
  const [joinRequests, setJoinRequests] = useState<TenantJoinRequest[]>([]);
  const joinRequestUnsubscribe = useRef<(() => void) | null>(null);
  const membershipUnsubscribe = useRef<(() => void) | null>(null);

  const clearJoinRequestListener = () => {
    try {
      joinRequestUnsubscribe.current?.();
    } catch (listenerError) {
      logger.warn('TenantProvider: failed to cleanup join request listener', listenerError);
    }
    joinRequestUnsubscribe.current = null;
  };

  const attachJoinRequestListener = useCallback(
    (tenantId: string) => {
      clearJoinRequestListener();
      joinRequestUnsubscribe.current = tenantService.listenToJoinRequests(
        tenantId,
        (requests) => {
          setJoinRequests(requests);
        },
        (listenerError) => {
          logger.warn('TenantProvider: join request listener error', listenerError);
          authService.flagReloginRequired?.('TenantProvider.joinRequests', listenerError);
          setError(listenerError?.message || 'Failed to load join requests');
        },
      );
    },
    [],
  );

  const loadTenantsFor = useCallback(
    async (nextMemberships: TenantMembership[], options?: { force?: boolean }) => {
      const uniqueTenantIds = Array.from(new Set(nextMemberships.map((membership) => membership.tenantId)));
      const targetIds = options?.force ? uniqueTenantIds : uniqueTenantIds.filter((tenantId) => !tenantMap[tenantId]);

      if (!targetIds.length) {
        return;
      }

      setLoadingTenants(true);
      try {
        const fetched = await tenantService.getTenantsByIds(targetIds);
        setTenantMap((prev) => {
          const next = { ...prev };
          fetched.forEach((tenant) => {
            next[tenant.id] = tenant;
          });
          return next;
        });
      } catch (loadError) {
        logger.error('TenantProvider: failed to load tenant metadata', loadError);
        authService.flagReloginRequired?.('TenantProvider.loadTenants', loadError);
        setError(loadError instanceof Error ? loadError.message : 'Failed to load coaching centers');
      } finally {
        setLoadingTenants(false);
      }
    },
    [tenantMap],
  );

  const bootstrapFromCache = useCallback(async () => {
    try {
      const [cachedTenantId, cachedMemberships] = await Promise.all([
        tenantService.getCachedSelectedTenant(),
        tenantService.getCachedMemberships(),
      ]);

      if (cachedTenantId) {
        setSelectedTenantId(cachedTenantId);
      }

      if (cachedMemberships.length) {
        const normalized = normalizeMembershipList(cachedMemberships);
        setMemberships(normalized);
        loadTenantsFor(normalized).catch((err) => logger.warn('TenantProvider: cache tenant load failed', err));
      }
    } catch (cacheError) {
      logger.warn('TenantProvider: failed to restore cache', cacheError);
    }
  }, [loadTenantsFor]);

  useEffect(() => {
    bootstrapFromCache();
  }, [bootstrapFromCache]);

  const attachMembershipListener = useCallback(
    (context?: string) => {
      if (!user?.uid) {
        membershipUnsubscribe.current?.();
        setMemberships([]);
        setTenantMap({});
        setSelectedTenantId(null);
        setInitializing(false);
        clearJoinRequestListener();
        return;
      }

      setInitializing(true);
      setError(null);

      membershipUnsubscribe.current?.();
      membershipUnsubscribe.current = tenantService.listenToMembershipsForUser(
        user.uid,
        (list) => {
          const normalizedList = normalizeMembershipList(list);
          setMemberships(normalizedList);
          setInitializing(false);
          void tenantService.cacheMemberships(normalizedList).catch((cacheError) => {
            logger.warn('TenantProvider: cache memberships failed', cacheError);
          });
          void loadTenantsFor(normalizedList);
        },
        (listenError) => {
          authService.flagReloginRequired?.('TenantProvider.memberships', listenError);
          setError(listenError?.message || 'Failed to load coaching centers');
          setInitializing(false);
        },
      );

      if (selectedTenantId) {
        attachJoinRequestListener(selectedTenantId);
      }

      if (context) {
        logger.debug('TenantProvider: reattached membership listener', { context });
      }
    },
    [user?.uid, loadTenantsFor, selectedTenantId, attachJoinRequestListener],
  );

  useEffect(() => {
    attachMembershipListener('initial');
    return () => {
      membershipUnsubscribe.current?.();
      membershipUnsubscribe.current = null;
    };
  }, [attachMembershipListener]);

  useEffect(() => {
    const unsubscribe = authService.registerFirestoreReinit?.(attachMembershipListener);
    return () => {
      try {
        unsubscribe?.();
      } catch {}
    };
  }, [attachMembershipListener]);

  useEffect(() => {
    if (!memberships.length) {
      setSelectedTenantId((prev) => (prev ? prev : null));
      clearJoinRequestListener();
      setJoinRequests([]);
      return;
    }

    const determineSelection = async () => {
      let nextTenantId = selectedTenantId;
      if (nextTenantId) {
        const stillMember = memberships.some(
          (membership) => membership.tenantId === nextTenantId && membership.status === 'active',
        );
        if (!stillMember) {
          nextTenantId = null;
        }
      }

      if (!nextTenantId) {
        const firstActive = memberships.find((membership) => membership.status === 'active');
        nextTenantId = firstActive?.tenantId || null;
      }

      if (nextTenantId !== selectedTenantId) {
        setSelectedTenantId(nextTenantId);
        await tenantService.cacheSelectedTenant(nextTenantId);
      }

      if (nextTenantId) {
        attachJoinRequestListener(nextTenantId);
      } else {
        clearJoinRequestListener();
      }
    };

    determineSelection().catch((selectionError) => logger.warn('TenantProvider: selection error', selectionError));
  }, [memberships, selectedTenantId, attachJoinRequestListener]);

  const selectTenant = useCallback(
    async (tenantId: string | null) => {
      if (tenantId === selectedTenantId) {
        return;
      }
      setSelectedTenantId(tenantId);
      await tenantService.cacheSelectedTenant(tenantId);
      if (tenantId) {
        attachJoinRequestListener(tenantId);
      } else {
        clearJoinRequestListener();
      }
    },
    [selectedTenantId, attachJoinRequestListener],
  );

  const refreshTenants = useCallback(async () => {
    if (!memberships.length) {
      return;
    }
    await loadTenantsFor(memberships, { force: true });
  }, [memberships, loadTenantsFor]);

  const applyTenantNotificationPreferencesSnapshot = useCallback(
    (tenantId: string, prefs: TenantNotificationPreferences) => {
      if (!tenantId) {
        return;
      }
      setTenantMap((prev) => {
        const current = prev[tenantId];
        if (!current) {
          return prev;
        }
        return {
          ...prev,
          [tenantId]: {
            ...current,
            notificationPreferences: { ...prefs },
            updatedAt: new Date().toISOString(),
          },
        };
      });
    },
    []
  );

  const activeMembership = useMemo(() => {
    if (!selectedTenantId) {
      return null;
    }
    return (
      memberships.find(
        (membership) => membership.tenantId === selectedTenantId && membership.status === 'active',
      ) || null
    );
  }, [memberships, selectedTenantId]);

  const activeTenant = useMemo(() => {
    if (!selectedTenantId) {
      return null;
    }
    return tenantMap[selectedTenantId] || null;
  }, [selectedTenantId, tenantMap]);

  const pendingMemberships = useMemo(
    () =>
      memberships.filter(
        (membership) => membership.status === 'pending_request' || membership.status === 'pending_invite',
      ),
    [memberships],
  );

  const tenants = useMemo(() => Object.values(tenantMap).sort((a, b) => a.name.localeCompare(b.name)), [tenantMap]);

  const loading = initializing || loadingTenants;

  const value: TenantContextValue = {
    memberships,
    tenants,
    activeTenant,
    activeMembership,
    loading,
    error,
    pendingMemberships,
    joinRequests,
    selectTenant,
    refreshTenants,
    applyTenantNotificationPreferencesSnapshot,
  };

  return <TenantContext.Provider value={value}>{children}</TenantContext.Provider>;
};

export const useTenant = (): TenantContextValue => {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error('useTenant must be used within a TenantProvider');
  }
  return context;
};
