import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { AlertTriangle, CheckCircle2, Circle, ChevronDown, ChevronUp } from 'lucide-react-native';
import Toast from 'react-native-toast-message';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { useTheme } from '@/hooks/useTheme';
import { useTenant } from '@/hooks/useTenantContext';
import { useAuth } from '@/hooks/useAuthUnified';
import { tenantService } from '@/services/tenantService';
import type { TenantChecklistItemId, TenantCode, TenantInvite } from '@/types';
import { logger } from '@/lib/logger';

export type OnboardingTarget = 'contact' | 'branding' | 'invites' | 'joinCodes' | 'notifications';

interface ChecklistItem {
  id: TenantChecklistItemId;
  title: string;
  description: string;
  status: 'done' | 'pending' | 'attention';
  loading?: boolean;
}

const STATUS_LABEL: Record<ChecklistItem['status'], string> = {
  done: 'Done',
  pending: 'Pending',
  attention: 'Action needed',
};

interface TenantOnboardingChecklistProps {
  onNavigate?: (target: OnboardingTarget) => void;
}

const targetByChecklistId: Record<TenantChecklistItemId, OnboardingTarget> = {
  'profile-basics': 'contact',
  branding: 'branding',
  team: 'invites',
  'join-codes': 'joinCodes',
  notifications: 'notifications',
};

const TenantOnboardingChecklist = ({ onNavigate }: TenantOnboardingChecklistProps) => {
  const { theme } = useTheme();
  const { activeTenant, activeMembership, refreshTenants } = useTenant();
  const { user } = useAuth();
  const [hasAnyJoinCode, setHasAnyJoinCode] = useState(false);
  const [codeListenerError, setCodeListenerError] = useState<string | null>(null);
  const [hasAnyTeamInvite, setHasAnyTeamInvite] = useState(false);
  const [inviteListenerError, setInviteListenerError] = useState<string | null>(null);
  const [joinCodesResolved, setJoinCodesResolved] = useState(false);
  const [invitesResolved, setInvitesResolved] = useState(false);
  const [joinCodeCacheAvailable, setJoinCodeCacheAvailable] = useState(false);
  const [teamInviteCacheAvailable, setTeamInviteCacheAvailable] = useState(false);
  const [actioningItem, setActioningItem] = useState<TenantChecklistItemId | null>(null);
  const [showCompletedItems, setShowCompletedItems] = useState(false);

  const checklistQuickCacheKey = useMemo(() => {
    if (!activeTenant?.id) {
      return null;
    }
    return `tenant_onboarding_quick_flags:${activeTenant.id}`;
  }, [activeTenant?.id]);

  const persistQuickFlags = async (patch: Partial<{ hasAnyJoinCode: boolean; hasAnyTeamInvite: boolean }>) => {
    if (!checklistQuickCacheKey) {
      return;
    }
    try {
      const existingRaw = await AsyncStorage.getItem(checklistQuickCacheKey);
      const existing = existingRaw ? (JSON.parse(existingRaw) as any) : {};
      const next = {
        ...(existing && typeof existing === 'object' ? existing : {}),
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      await AsyncStorage.setItem(checklistQuickCacheKey, JSON.stringify(next));
    } catch (error) {
      logger.warn('TenantOnboardingChecklist: failed to persist quick flags', error);
    }
  };

  useEffect(() => {
    if (!checklistQuickCacheKey) {
      setJoinCodeCacheAvailable(false);
      setTeamInviteCacheAvailable(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(checklistQuickCacheKey);
        if (cancelled) return;
        if (!raw) {
          setJoinCodeCacheAvailable(false);
          setTeamInviteCacheAvailable(false);
          return;
        }
        const parsed = JSON.parse(raw) as any;
        const cachedJoin = typeof parsed?.hasAnyJoinCode === 'boolean' ? parsed.hasAnyJoinCode : null;
        const cachedInvite = typeof parsed?.hasAnyTeamInvite === 'boolean' ? parsed.hasAnyTeamInvite : null;
        if (typeof cachedJoin === 'boolean') {
          setHasAnyJoinCode(cachedJoin);
          setJoinCodeCacheAvailable(true);
        } else {
          setJoinCodeCacheAvailable(false);
        }
        if (typeof cachedInvite === 'boolean') {
          setHasAnyTeamInvite(cachedInvite);
          setTeamInviteCacheAvailable(true);
        } else {
          setTeamInviteCacheAvailable(false);
        }
      } catch (error) {
        if (!cancelled) {
          setJoinCodeCacheAvailable(false);
          setTeamInviteCacheAvailable(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checklistQuickCacheKey]);

  const canManageTenant = useMemo(() => {
    if (!activeMembership) {
      return false;
    }
    return activeMembership.role === 'owner' || activeMembership.role === 'admin';
  }, [activeMembership]);

  useEffect(() => {
    if (!activeTenant?.id || !canManageTenant) {
      setHasAnyJoinCode(false);
      setCodeListenerError(null);
      setJoinCodesResolved(false);
      return () => undefined;
    }

    // Keep this listener cheap: we only care if any code exists.
    const CHECKLIST_CODE_LIST_LIMIT = 1;

    const unsubscribe = tenantService.listenToCodes(
      activeTenant.id,
      (codes: TenantCode[]) => {
        setHasAnyJoinCode(codes.length > 0);
        setJoinCodesResolved(true);
        setCodeListenerError(null);
        void persistQuickFlags({ hasAnyJoinCode: codes.length > 0 });
      },
      (error) => {
        logger.warn('TenantOnboardingChecklist: join code listener failed', error);
        setCodeListenerError(error?.message || 'Unable to load join codes');
        setJoinCodesResolved(true);
      },
      CHECKLIST_CODE_LIST_LIMIT,
    );

    return () => {
      try {
        unsubscribe?.();
      } catch (cleanupError) {
        logger.warn('TenantOnboardingChecklist: cleanup failed', cleanupError);
      }
    };
  }, [activeTenant?.id, canManageTenant]);

  useEffect(() => {
    if (!activeTenant?.id || !canManageTenant) {
      setHasAnyTeamInvite(false);
      setInviteListenerError(null);
      setInvitesResolved(false);
      return () => undefined;
    }

    // Keep this listener cheap: we only care if any invite exists.
    const CHECKLIST_INVITE_LIST_LIMIT = 1;

    const unsubscribe = tenantService.listenToInvites(
      activeTenant.id,
      (invites: TenantInvite[]) => {
        setHasAnyTeamInvite(invites.length > 0);
        setInvitesResolved(true);
        setInviteListenerError(null);
        void persistQuickFlags({ hasAnyTeamInvite: invites.length > 0 });
      },
      (error) => {
        logger.warn('TenantOnboardingChecklist: invite listener failed', error);
        setInviteListenerError(error?.message || 'Unable to load invites');
        setInvitesResolved(true);
      },
      CHECKLIST_INVITE_LIST_LIMIT,
    );

    return () => {
      try {
        unsubscribe?.();
      } catch (cleanupError) {
        logger.warn('TenantOnboardingChecklist: invite cleanup failed', cleanupError);
      }
    };
  }, [activeTenant?.id, canManageTenant]);

  const dismissedItems = activeTenant?.onboardingProgress?.dismissedChecklistItems || [];
  const dismissedSet = useMemo(() => new Set(dismissedItems), [dismissedItems]);

  const checklistItems: ChecklistItem[] = useMemo(() => {
    if (!activeTenant) {
      return [];
    }
    const hasContact = Boolean(activeTenant.contactEmail || activeTenant.contactPhone);
    const hasTimezone = Boolean(activeTenant.timezone);
    const hasBranding = Boolean(activeTenant.branding?.logoUrl || activeTenant.logoUrl);
    const hasTeam = (activeTenant.membershipCounts?.total || 1) > 1 || hasAnyTeamInvite;
    const hasNotificationPrefs = Boolean(activeTenant.notificationPreferences);

    const teamLoading = !invitesResolved && !teamInviteCacheAvailable;
    const joinCodeLoading = !joinCodesResolved && !joinCodeCacheAvailable;

    return [
      {
        id: 'profile-basics',
        title: 'Confirm profile basics',
        description: 'Set contact email, phone, and timezone so reminders show the right footer.',
        status: hasContact && hasTimezone ? 'done' : 'pending',
      },
      {
        id: 'branding',
        title: 'Upload your branding',
        description: 'Add a logo/hero image so parents recognize your workspace.',
        status: hasBranding ? 'done' : 'pending',
      },
      {
        id: 'team',
        title: 'Invite your staff',
        description: 'Owners/admins should invite at least one teammate for redundancy.',
        status: hasTeam ? 'done' : 'attention',
        loading: teamLoading,
      },
      {
        id: 'join-codes',
        title: 'Generate a join code',
        description: 'Share codes with trusted partners when email-based invites are inconvenient.',
        status: hasAnyJoinCode ? 'done' : 'pending',
        loading: joinCodeLoading,
      },
      {
        id: 'notifications',
        title: 'Review notifications',
        description: 'Decide who receives join-request and membership alerts.',
        status: hasNotificationPrefs ? 'done' : 'pending',
      },
    ];
  }, [activeTenant, hasAnyJoinCode, hasAnyTeamInvite, invitesResolved, joinCodesResolved, joinCodeCacheAvailable, teamInviteCacheAvailable]);

  const visibleItems = checklistItems.filter(Boolean);
  const completedCount = visibleItems.filter((item) => item.status === 'done').length;
  const progressPercent = visibleItems.length ? Math.round((completedCount / visibleItems.length) * 100) : 0;

  const itemsToRender = useMemo(() => {
    if (showCompletedItems) {
      return visibleItems;
    }
    return visibleItems.filter((item) => item.status !== 'done');
  }, [showCompletedItems, visibleItems]);

  const persistDismissedItems = async (items: TenantChecklistItemId[]) => {
    if (!activeTenant?.id) {
      return;
    }
    try {
      await tenantService.updateTenant({
        id: activeTenant.id,
        onboardingProgress: {
          ...(activeTenant.onboardingProgress || {}),
          dismissedChecklistItems: items,
          lastReviewedAt: new Date().toISOString(),
        },
        updatedBy: user?.uid,
      });
      await refreshTenants();
    } catch (error) {
      logger.warn('TenantOnboardingChecklist: failed to persist progress', error);
      throw error;
    }
  };

  const handleDismissItem = async (itemId: TenantChecklistItemId) => {
    if (!activeTenant?.id) {
      return;
    }
    setActioningItem(itemId);
    const next = Array.from(new Set([...dismissedItems, itemId]));
    try {
      await persistDismissedItems(next);
      Toast.show({
        type: 'info',
        text1: 'Checklist item snoozed',
        text2: 'It will stay hidden until you restore it.',
        position: 'top',
        topOffset: 60,
      });
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: 'Unable to dismiss',
        text2: error instanceof Error ? error.message : 'Try again later.',
        position: 'top',
        topOffset: 60,
      });
    } finally {
      setActioningItem(null);
    }
  };

  const handleRestoreItem = async (itemId: TenantChecklistItemId) => {
    if (!activeTenant?.id) {
      return;
    }
    setActioningItem(itemId);
    const next = dismissedItems.filter((id) => id !== itemId);
    try {
      await persistDismissedItems(next);
      Toast.show({
        type: 'success',
        text1: 'Checklist item restored',
        position: 'top',
        topOffset: 60,
      });
    } catch (error) {
      Toast.show({
        type: 'error',
        text1: 'Unable to restore',
        text2: error instanceof Error ? error.message : 'Try again later.',
        position: 'top',
        topOffset: 60,
      });
    } finally {
      setActioningItem(null);
    }
  };

  if (!canManageTenant || !activeTenant) {
    return null;
  }

  return (
    <View style={[styles.card, { borderColor: theme.border, backgroundColor: theme.surface }]}> 
      <View style={styles.header}>
        <View>
          <Text style={[styles.title, { color: theme.text }]}>Onboarding checklist</Text>
          <Text style={[styles.subtitle, { color: theme.textSecondary }]}>
            {completedCount}/{visibleItems.length} complete · {progressPercent}%
          </Text>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.progressTrack, { backgroundColor: theme.border }]}> 
            <View
              style={[styles.progressFill, { backgroundColor: theme.primary, width: `${progressPercent}%` }]}
            />
          </View>
          {completedCount > 0 ? (
            <TouchableOpacity
              onPress={() => setShowCompletedItems((prev) => !prev)}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel={showCompletedItems ? 'Hide completed checklist items' : 'Show completed checklist items'}
              style={[styles.chevronButton, { borderColor: theme.border, backgroundColor: theme.background }]}
            >
              {showCompletedItems ? (
                <ChevronUp size={18} color={theme.textSecondary} />
              ) : (
                <ChevronDown size={18} color={theme.textSecondary} />
              )}
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      {(codeListenerError || inviteListenerError) && (
        <Text style={[styles.errorText, { color: theme.error }]}>
          {codeListenerError || inviteListenerError}
        </Text>
      )}

      {itemsToRender.map((item) => {
        const target = targetByChecklistId[item.id];
        const isPressable = Boolean(target && onNavigate);
        const isDismissed = dismissedSet.has(item.id);
        const isActionPending = actioningItem === item.id;
        const isComplete = item.status === 'done';
        return (
          <TouchableOpacity
            key={item.id}
            style={[
              styles.row,
              {
                borderColor: theme.border,
                opacity: isDismissed ? 0.65 : 1,
              },
            ]}
            activeOpacity={0.85}
            disabled={!isPressable}
            onPress={() => {
              if (target && onNavigate) {
                onNavigate(target);
              }
            }}
          >
          <View style={styles.iconWrapper}>
            {item.status === 'done' ? (
              <CheckCircle2 size={18} color={theme.success} />
            ) : item.status === 'attention' ? (
              <AlertTriangle size={18} color={theme.warning} />
            ) : (
              <Circle size={18} color={theme.textSecondary} />
            )}
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.itemTitle, { color: theme.text }]}>{item.title}</Text>
            <Text style={[styles.itemDescription, { color: theme.textSecondary }]}>{item.description}</Text>
          </View>
          <View style={[styles.statusPill, { borderColor: theme.border }]}> 
            <Text
              style={[
                styles.statusPillText,
                {
                  color: isComplete
                    ? theme.success
                    : isDismissed
                      ? theme.textSecondary
                      : item.status === 'attention'
                        ? theme.warning
                        : theme.textSecondary,
                },
              ]}
            >
              {isDismissed ? 'Dismissed' : item.loading ? 'Checking…' : STATUS_LABEL[item.status]}
            </Text>
          </View>
          {!isComplete && (
            <View style={styles.rowActions}>
              {isDismissed ? (
                <TouchableOpacity
                  style={[styles.actionChip, { borderColor: theme.primary }]}
                  disabled={isActionPending}
                  onPress={() => handleRestoreItem(item.id)}
                >
                  <Text
                    style={[styles.actionChipText, { color: theme.primary }]}
                  >
                    {isActionPending ? 'Restoring…' : 'Restore'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  style={[styles.actionChip, { borderColor: theme.border }]}
                  disabled={isActionPending}
                  onPress={() => handleDismissItem(item.id)}
                >
                  <Text
                    style={[styles.actionChipText, { color: theme.textSecondary }]}
                  >
                    {isActionPending ? 'Saving…' : 'Dismiss'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
    gap: 12,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  subtitle: {
    fontSize: 13,
    marginTop: 4,
  },
  progressTrack: {
    flexBasis: 120,
    height: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  chevronButton: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 6,
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
  },
  errorText: {
    fontSize: 12,
    marginBottom: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    gap: 12,
    flexWrap: 'wrap',
  },
  iconWrapper: {
    width: 28,
    alignItems: 'center',
    paddingTop: 3,
  },
  itemTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  itemDescription: {
    fontSize: 13,
    lineHeight: 18,
  },
  statusPill: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    alignSelf: 'flex-start',
  },
  statusPillText: {
    fontSize: 12,
    fontWeight: '600',
  },
  rowActions: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 8,
  },
  actionChip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  actionChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
});

export default TenantOnboardingChecklist;
