import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  ScrollView,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Toast from 'react-native-toast-message';
import { AlertCircle, KeyRound, Link2 } from 'lucide-react-native';

import { useTheme } from '@/hooks/useTheme';
import { useTenant } from '@/hooks/useTenantContext';
import { useAuth } from '@/hooks/useAuthUnified';
import { tenantService } from '@/services/tenantService';
import { getReviewerQuickJoinCode } from '@/services/reviewerQuickJoin';
import type { TenantCode } from '@/types';
import { formatDateToString } from '@/lib/utils';
import { logger } from '@/lib/logger';
import { SkeletonBar, SkeletonRow } from '@/components/Skeleton';

const EXPIRY_OPTIONS = [7, 14, 30, 60];
const USAGE_CAP_OPTIONS = [5, 10, 25, 50];
const DEFAULT_USAGE_CAP = USAGE_CAP_OPTIONS[0];
const CODE_PAGE_SIZE = 5;
const MAX_ACTIVE_CODES = 5;
type CodeStatusFilter = 'all' | TenantCode['status'];

const statusChipColor = (
  status: TenantCode['status'],
  theme: ReturnType<typeof useTheme>['theme'],
): { backgroundColor: string; color: string } => {
  switch (status) {
    case 'active':
      return { backgroundColor: `${theme.primary}1A`, color: theme.primary };
    case 'revoked':
      return { backgroundColor: `${theme.error}10`, color: theme.error };
    default:
      return { backgroundColor: `${theme.warning}10`, color: theme.warning };
  }
};

const parseIsoDate = (value?: string | null): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

export interface TenantJoinCodeManagerHandle {
  flashGenerateHint: () => void;
}

interface TenantJoinCodeManagerProps {
  isRefreshing?: boolean;
}

const TenantJoinCodeManager = forwardRef<TenantJoinCodeManagerHandle, TenantJoinCodeManagerProps>(
  ({ isRefreshing = false }, ref) => {
  const { theme } = useTheme();
  const { activeTenant, activeMembership, joinRequests } = useTenant();
  const { user } = useAuth();
  const skeletonBaseColor = `${theme.textSecondary}20`;
  const skeletonHighlightColor = `${theme.textSecondary}35`;

  const canManageCodes = useMemo(() => {
    if (!activeMembership) return false;
    return activeMembership.role === 'owner' || activeMembership.role === 'admin';
  }, [activeMembership]);

  const [codes, setCodes] = useState<TenantCode[]>([]);
  const [loading, setLoading] = useState(() => Boolean(activeTenant?.id && canManageCodes));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [revokingCodeId, setRevokingCodeId] = useState<string | null>(null);
  const [expiryDays, setExpiryDays] = useState<number>(14);
  const [usageCapOption, setUsageCapOption] = useState<number>(DEFAULT_USAGE_CAP);
  const [showGenerateModal, setShowGenerateModal] = useState(false);
  const [highlightGenerate, setHighlightGenerate] = useState(false);
  const [pendingRevokeCode, setPendingRevokeCode] = useState<TenantCode | null>(null);
  const [showRevokeModal, setShowRevokeModal] = useState(false);
  const [visibleCodeCount, setVisibleCodeCount] = useState(CODE_PAGE_SIZE);
  const [codeStatusFilter, setCodeStatusFilter] = useState<CodeStatusFilter>('active');
  const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const reviewerQuickJoinCode = useMemo(() => getReviewerQuickJoinCode(), []);

  useEffect(() => {
    if (!activeTenant?.id || !canManageCodes) {
      setCodes([]);
      setLoading(false);
      return () => undefined;
    }
    setLoading(true);
    setError(null);
    const unsubscribe = tenantService.listenToCodes(
      activeTenant.id,
      (list) => {
        setCodes(list);
        setLoading(false);
      },
      (listenError) => {
        logger.warn('TenantJoinCodeManager: listen failed', listenError);
        setError(listenError?.message || 'Failed to load join codes');
        setLoading(false);
      },
    );
    return () => {
      try {
        unsubscribe?.();
      } catch (cleanupError) {
        logger.warn('TenantJoinCodeManager: cleanup failed', cleanupError);
      }
    };
  }, [activeTenant?.id, canManageCodes]);

  const pendingJoinRequests = useMemo(
    () => joinRequests.filter((request) => request.status === 'pending'),
    [joinRequests],
  );
  const pendingRequestLookup = useMemo(() => {
    const byId: Record<string, number> = {};
    const byValue: Record<string, number> = {};
    pendingJoinRequests.forEach((request) => {
      if (request.joinCodeId) {
        byId[request.joinCodeId] = (byId[request.joinCodeId] || 0) + 1;
        return;
      }
      if (request.joinCodeValue) {
        const normalized = request.joinCodeValue.trim().toUpperCase();
        if (normalized) {
          byValue[normalized] = (byValue[normalized] || 0) + 1;
        }
      }
    });
    return { byId, byValue };
  }, [pendingJoinRequests]);

  const availableStatusFilters = useMemo(() => {
    const statusSet = new Set<TenantCode['status']>();
    codes.forEach((code) => statusSet.add(code.status));
    return Array.from(statusSet);
  }, [codes]);

  const statusFilterOptions = useMemo<CodeStatusFilter[]>(() => {
    const options: CodeStatusFilter[] = ['all', 'active', 'revoked', 'expired'];
    availableStatusFilters.forEach((status) => {
      if (!options.includes(status as CodeStatusFilter)) {
        options.push(status as CodeStatusFilter);
      }
    });
    return options;
  }, [availableStatusFilters]);

  const filteredCodes = useMemo(() => {
    if (codeStatusFilter === 'all') {
      return codes;
    }
    return codes.filter((code) => code.status === codeStatusFilter);
  }, [codes, codeStatusFilter]);

  const visibleCodes = useMemo(() => filteredCodes.slice(0, visibleCodeCount), [filteredCodes, visibleCodeCount]);
  const hasMoreCodes = filteredCodes.length > visibleCodes.length;
  const activeCodeCount = useMemo(() => codes.filter((code) => code.status === 'active').length, [codes]);
  const isAtOrOverActiveCodeLimit = activeCodeCount >= MAX_ACTIVE_CODES;
  const canCreateMoreCodes = !isAtOrOverActiveCodeLimit;
  const activeCodeCounterColor = isAtOrOverActiveCodeLimit ? theme.error : theme.primary;
  const modalLimitMessage = isAtOrOverActiveCodeLimit
    ? 'Revoke an active code to create a new one.'
    : `You can keep up to ${MAX_ACTIVE_CODES} active codes.`;

  useEffect(() => {
    setCodeStatusFilter('active');
  }, [activeTenant?.id]);

  useEffect(() => {
    setVisibleCodeCount(CODE_PAGE_SIZE);
  }, [activeTenant?.id, codeStatusFilter]);

  useEffect(() => {
    setVisibleCodeCount((prev) => {
      if (!filteredCodes.length) {
        return CODE_PAGE_SIZE;
      }
      return Math.min(prev, filteredCodes.length);
    });
  }, [filteredCodes.length]);

  const handleGenerateCode = useCallback(async () => {
    if (!user?.uid || !activeTenant?.id) {
      Alert.alert('Unable to create code', 'Sign in and select a coaching center first.');
      return;
    }
    if (creating) {
      return;
    }
    setCreating(true);
    try {
      await tenantService.createTenantCode({
        tenantId: activeTenant.id,
        createdBy: user.uid,
        expiresInDays: expiryDays,
        usageCap: usageCapOption,
      });
      setShowGenerateModal(false);
      Toast.show({
        type: 'success',
        text1: 'Join code created',
        text2: 'Share it with teammates to let them request access.',
        position: 'top',
        topOffset: 60,
      });
    } catch (createError) {
      logger.error('TenantJoinCodeManager: create code failed', createError);
      const message =
        createError instanceof Error ? createError.message : 'Failed to create join code. Try again later.';
      Alert.alert('Unable to create join code', message);
    } finally {
      setCreating(false);
    }
  }, [activeTenant?.id, creating, expiryDays, user?.uid]);

  const handleCopyCode = useCallback(async (codeValue: string, codeId: string) => {
    try {
      await Clipboard.setStringAsync(codeValue);
      Toast.show({
        type: 'success',
        text1: 'Code copied',
        text2: 'Send it privately to trusted teammates.',
        position: 'top',
        topOffset: 60,
      });
      setCopiedCodeId(codeId);
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => setCopiedCodeId(null), 2000);
    } catch (copyError) {
      logger.warn('TenantJoinCodeManager: copy failed', copyError);
      Toast.show({
        type: 'error',
        text1: 'Copy failed',
        text2: 'Unable to copy join code. Try again.',
        position: 'top',
        topOffset: 60,
      });
    }
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      flashGenerateHint: () => {
        setHighlightGenerate(true);
        if (highlightTimeoutRef.current) {
          clearTimeout(highlightTimeoutRef.current);
        }
        highlightTimeoutRef.current = setTimeout(() => setHighlightGenerate(false), 2200);
      },
    }),
    [],
  );

  useEffect(() => {
    return () => {
      if (highlightTimeoutRef.current) {
        clearTimeout(highlightTimeoutRef.current);
      }
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const handleRevokeCode = useCallback(
    async (codeId: string) => {
      if (!user?.uid || !activeTenant?.id) {
        Alert.alert('Unable to revoke', 'Sign in and select a coaching center first.');
        return;
      }
      setRevokingCodeId(codeId);
      try {
        await tenantService.revokeCode(activeTenant.id, codeId, user.uid);
        Toast.show({
          type: 'info',
          text1: 'Join code revoked',
          text2: 'New applicants can no longer use this code.',
          position: 'top',
          topOffset: 60,
        });
      } catch (revokeError) {
        logger.warn('TenantJoinCodeManager: revoke failed', revokeError);
        Toast.show({
          type: 'error',
          text1: 'Unable to revoke',
          text2: revokeError instanceof Error ? revokeError.message : 'Please try again.',
          position: 'top',
          topOffset: 60,
        });
      } finally {
        setRevokingCodeId(null);
      }
    },
    [activeTenant?.id, user?.uid],
  );

  const closeRevokeModal = useCallback(() => {
    setPendingRevokeCode(null);
    setShowRevokeModal(false);
  }, []);

  const confirmRevokeCode = useCallback((code: TenantCode) => {
    const normalizedCode = code.code.trim().toUpperCase();
    if (reviewerQuickJoinCode && normalizedCode === reviewerQuickJoinCode) {
      Alert.alert(
        'Protected join code',
        'This code is reserved for reviewer quick join and cannot be revoked from this screen.',
      );
      return;
    }
    setPendingRevokeCode(code);
    setShowRevokeModal(true);
  }, [reviewerQuickJoinCode]);

  const submitRevokeCode = useCallback(() => {
    if (!pendingRevokeCode) {
      return;
    }
    void handleRevokeCode(pendingRevokeCode.id);
    setShowRevokeModal(false);
    setPendingRevokeCode(null);
  }, [handleRevokeCode, pendingRevokeCode]);

  const handleLoadMoreCodes = () => {
    setVisibleCodeCount((prev) => Math.min(prev + CODE_PAGE_SIZE, filteredCodes.length));
  };

  const closeGenerateModal = useCallback(() => {
    if (creating) {
      return;
    }
    setShowGenerateModal(false);
  }, [creating]);

  const submitGenerateCode = useCallback(() => {
    if (isAtOrOverActiveCodeLimit) {
      return;
    }
    void handleGenerateCode();
  }, [handleGenerateCode, isAtOrOverActiveCodeLimit]);

  const handleOpenGenerateModal = useCallback(() => {
    setShowGenerateModal(true);
  }, []);

  const renderJoinCodeSkeletonList = () => (
    <View style={{ marginTop: 4 }}>
      {[0, 1, 2].map((index) => (
        <View
          key={`join-code-skeleton-${index}`}
          style={[styles.codeCard, { borderColor: theme.border, backgroundColor: theme.surface }]}
        >
          <SkeletonRow
            style={{ marginBottom: 12 }}
            lines={[{ width: '55%', height: 16 }, { width: '35%', height: 10 }]}
            rightWidth={70}
            baseColor={skeletonBaseColor}
            highlightColor={skeletonHighlightColor}
          />
          <SkeletonBar
            style={{ width: '70%', height: 10, borderRadius: 6, marginBottom: 8 }}
            baseColor={skeletonBaseColor}
            highlightColor={skeletonHighlightColor}
          />
          <SkeletonBar
            style={{ width: '45%', height: 10, borderRadius: 6 }}
            baseColor={skeletonBaseColor}
            highlightColor={skeletonHighlightColor}
          />
          <SkeletonBar
            style={{ width: '60%', height: 18, borderRadius: 10, marginTop: 12 }}
            baseColor={skeletonBaseColor}
            highlightColor={skeletonHighlightColor}
          />
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <SkeletonBar
              style={{ flex: 1, height: 36, borderRadius: 999 }}
              baseColor={skeletonBaseColor}
              highlightColor={skeletonHighlightColor}
            />
            <SkeletonBar
              style={{ flex: 1, height: 36, borderRadius: 999 }}
              baseColor={skeletonBaseColor}
              highlightColor={skeletonHighlightColor}
            />
          </View>
        </View>
      ))}
    </View>
  );

  if (!canManageCodes) {
    return null;
  }

  const showSkeleton = (loading && codes.length === 0) || isRefreshing;

  return (
    <View
      style={[
        styles.card,
        { borderColor: theme.border, backgroundColor: theme.surface },
        highlightGenerate && {
          borderColor: theme.primary,
          shadowColor: theme.primary,
          shadowRadius: 12,
          shadowOpacity: 0.2,
          shadowOffset: { width: 0, height: 0 },
          elevation: 4,
        },
      ]}
    > 
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <KeyRound size={18} color={theme.primary} />
          <Text style={[styles.title, { color: theme.text }]}>Join codes</Text>
        </View>
        <TouchableOpacity
          style={[
            styles.iconButton,
            {
              borderColor: highlightGenerate ? theme.primary : theme.border,
              backgroundColor: highlightGenerate ? `${theme.primary}12` : 'transparent',
            },
          ]}
          onPress={handleOpenGenerateModal}
          disabled={creating}
        >
          {creating ? (
            <ActivityIndicator size="small" color={theme.primary} />
          ) : (
            <Text style={[styles.iconButtonText, { color: theme.primary }]}>Generate</Text>
          )}
        </TouchableOpacity>
      </View>

      <Text style={[styles.description, { color: theme.textSecondary }]}>Share a code when you prefer manual approvals instead of single-use email invites.</Text>
      <Text style={[styles.limitContext, { color: activeCodeCounterColor }]}>Active codes: {activeCodeCount}/{MAX_ACTIVE_CODES}</Text>

      <View style={styles.filterRow}>
        {statusFilterOptions.map((status) => {
          const active = codeStatusFilter === status;
          const label = status === 'all' ? 'All codes' : `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
          return (
            <TouchableOpacity
              key={status}
              style={[
                styles.filterChip,
                {
                  backgroundColor: active ? theme.primary : theme.surface,
                  borderColor: active ? theme.primary : theme.border,
                },
              ]}
              onPress={() => setCodeStatusFilter(status)}
            >
              <Text style={[styles.filterChipText, { color: active ? '#fff' : theme.text }]}>{label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {error && (
        <View style={[styles.alertRow, { backgroundColor: `${theme.error}10` }]}> 
          <AlertCircle size={16} color={theme.error} />
          <Text style={[styles.alertText, { color: theme.error }]}>{error}</Text>
        </View>
      )}

      {showSkeleton ? (
        renderJoinCodeSkeletonList()
      ) : codes.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>No join codes yet</Text>
          <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}>Generate a code to let applicants request access.</Text>
        </View>
      ) : filteredCodes.length === 0 ? (
        <View style={styles.emptyState}>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>No codes match that filter</Text>
          <Text style={[styles.emptySubtitle, { color: theme.textSecondary }]}>This status doesn’t have any join codes yet.</Text>
          <TouchableOpacity
            style={[styles.filterResetButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
            onPress={() => setCodeStatusFilter('all')}
          >
            <Text style={[styles.filterResetText, { color: theme.primary }]}>Show all codes</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <>
        <View style={styles.listWindow}>
          <ScrollView
            nestedScrollEnabled
            showsVerticalScrollIndicator={false}
            style={styles.listWindowScroll}
            contentContainerStyle={styles.listWindowContent}
          >
        {visibleCodes.map((code) => {
          const statusColors = statusChipColor(code.status, theme);
          const expiresAtDate = parseIsoDate(code.expiresAt);
          const createdAtDate = parseIsoDate(code.createdAt);
          const normalizedCodeValue = code.code.trim().toUpperCase();
          const isReviewerQuickJoinCode = Boolean(
            reviewerQuickJoinCode && normalizedCodeValue === reviewerQuickJoinCode,
          );
          const pendingCount =
            pendingRequestLookup.byId[code.id] ?? pendingRequestLookup.byValue[normalizedCodeValue] ?? 0;
          return (
            <View key={code.id} style={[styles.codeCard, { borderColor: theme.border }]}> 
              <View style={styles.codeHeader}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.codeValue, { color: theme.text }]}>{code.code}</Text>
                  <Text style={[styles.codeMeta, { color: theme.textSecondary }]}>Created {createdAtDate ? formatDateToString(createdAtDate) : '—'}</Text>
                </View>
                <View style={[styles.statusChip, { backgroundColor: statusColors.backgroundColor }]}>
                  <Text style={[styles.statusChipText, { color: statusColors.color }]}>{code.status}</Text>
                </View>
              </View>
              <View style={styles.codeMetaRow}>
                {expiresAtDate && (
                  <Text style={[styles.codeMeta, { color: theme.textSecondary }]}>Expires {formatDateToString(expiresAtDate)}</Text>
                )}
                <Text style={[styles.codeMeta, { color: theme.textSecondary }]}>Usage: {typeof code.usageCap === 'number' ? `${code.usageCount || 0}/${code.usageCap}` : code.usageCount || 0}</Text>
                {typeof code.usageCap === 'number' && code.usageCap > 0 && (
                  <Text style={[styles.codeMeta, { color: theme.textSecondary }]}>Limit: {code.usageCap} requests</Text>
                )}
              </View>
              {pendingCount > 0 && (
                <View
                  style={[
                    styles.pendingBadge,
                    { borderColor: `${theme.warning}30`, backgroundColor: `${theme.warning}10` },
                  ]}
                >
                  <KeyRound size={14} color={theme.warning} />
                  <Text style={[styles.pendingBadgeText, { color: theme.warning }]}> 
                    {pendingCount === 1 ? '1 pending request' : `${pendingCount} pending requests`} awaiting review
                  </Text>
                </View>
              )}
              <View style={styles.actionsRow}>
                <TouchableOpacity
                  style={[
                    styles.actionButton,
                    {
                      borderColor: theme.border,
                      backgroundColor: copiedCodeId === code.id ? `${theme.primary}10` : 'transparent',
                    },
                  ]}
                  onPress={() => handleCopyCode(code.code, code.id)}
                >
                  <Link2 size={16} color={copiedCodeId === code.id ? theme.primary : theme.textSecondary} />
                  <Text
                    style={[
                      styles.actionButtonText,
                      { color: copiedCodeId === code.id ? theme.primary : theme.textSecondary },
                    ]}
                  >
                    {copiedCodeId === code.id ? 'Copied!' : 'Copy code'}
                  </Text>
                </TouchableOpacity>
                {code.status === 'active' && !isReviewerQuickJoinCode && (
                  <TouchableOpacity
                    style={[styles.actionButton, { borderColor: theme.border }]}
                    onPress={() => confirmRevokeCode(code)}
                    disabled={revokingCodeId === code.id}
                  >
                    {revokingCodeId === code.id ? (
                      <ActivityIndicator size="small" color={theme.error} />
                    ) : (
                      <Text style={[styles.actionButtonText, { color: theme.error }]}>Revoke</Text>
                    )}
                  </TouchableOpacity>
                )}
              </View>
            </View>
          );
        })}
        </ScrollView>
        </View>
        {hasMoreCodes && (
          <TouchableOpacity
            style={[styles.loadMoreButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
            onPress={handleLoadMoreCodes}
          >
            <Text style={[styles.loadMoreButtonText, { color: theme.primary }]}>Load more codes</Text>
          </TouchableOpacity>
        )}
        </>
      )}

      <Modal
        visible={showGenerateModal}
        transparent
        animationType="fade"
        onRequestClose={closeGenerateModal}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.surface }]}> 
            <Text style={[styles.modalTitle, { color: theme.text }]}>Generate join code</Text>
            <Text style={[styles.modalMessage, { color: theme.textSecondary }]}>Choose how long the code should stay active before it expires.</Text>
            <View style={styles.expiryRow}>
              {EXPIRY_OPTIONS.map((days) => {
                const active = days === expiryDays;
                return (
                  <TouchableOpacity
                    key={days}
                    style={[
                      styles.expiryChip,
                      {
                        backgroundColor: active ? theme.primary : theme.surface,
                        borderColor: active ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => setExpiryDays(days)}
                    disabled={creating}
                  >
                    <Text style={[styles.expiryChipText, { color: active ? '#fff' : theme.text }]}>{days} days</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <Text style={[styles.modalMessage, { color: theme.textSecondary }]}>Limit how many members can use this code.</Text>
            <View style={styles.expiryRow}>
              {USAGE_CAP_OPTIONS.map((cap) => {
                const active = usageCapOption === cap;
                const label = `${cap} requests`;
                return (
                  <TouchableOpacity
                    key={String(cap)}
                    style={[
                      styles.expiryChip,
                      {
                        backgroundColor: active ? theme.primary : theme.surface,
                        borderColor: active ? theme.primary : theme.border,
                      },
                    ]}
                    onPress={() => setUsageCapOption(cap)}
                    disabled={creating}
                  >
                    <Text style={[styles.expiryChipText, { color: active ? '#fff' : theme.text }]}>{label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <View
              style={[
                styles.modalLimitBanner,
                {
                  borderColor: isAtOrOverActiveCodeLimit ? `${theme.error}30` : `${theme.primary}20`,
                  backgroundColor: isAtOrOverActiveCodeLimit ? `${theme.error}10` : `${theme.primary}10`,
                },
              ]}
            >
              <Text
                style={[
                  styles.modalLimitBannerText,
                  { color: isAtOrOverActiveCodeLimit ? theme.error : theme.text },
                ]}
              >
                Active codes: {activeCodeCount}/{MAX_ACTIVE_CODES} · {modalLimitMessage}
              </Text>
            </View>
            <Text style={[styles.modalHint, { color: theme.textSecondary }]}>You can share the code immediately after it is created.</Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, { borderColor: theme.border, backgroundColor: theme.surface, opacity: creating ? 0.6 : 1 }]}
                onPress={closeGenerateModal}
                disabled={creating}
              >
                <Text style={[styles.modalButtonText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalButton,
                  {
                    borderColor: 'transparent',
                    backgroundColor: theme.primary,
                    opacity: creating || isAtOrOverActiveCodeLimit ? 0.7 : 1,
                  },
                ]}
                onPress={submitGenerateCode}
                disabled={creating || isAtOrOverActiveCodeLimit}
              >
                {creating ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={[styles.modalButtonText, { color: '#fff' }]}>Generate</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showRevokeModal}
        transparent
        animationType="fade"
        onRequestClose={closeRevokeModal}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.surface }]}> 
            <Text style={[styles.modalTitle, { color: theme.text }]}>Revoke join code?</Text>
            <Text style={[styles.modalMessage, { color: theme.textSecondary }]}> 
              Stop accepting new members via {pendingRevokeCode?.code || 'this code'}? This action cannot be undone.
            </Text>
            <View style={styles.modalActions}>
              <TouchableOpacity
                style={[styles.modalButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
                onPress={closeRevokeModal}
                disabled={revokingCodeId !== null}
              >
                <Text style={[styles.modalButtonText, { color: theme.text }]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.modalButton,
                  styles.modalDangerButton,
                  {
                    backgroundColor: theme.error,
                    opacity:
                      !pendingRevokeCode || revokingCodeId === pendingRevokeCode?.id ? 0.7 : 1,
                  },
                ]}
                onPress={submitRevokeCode}
                disabled={!pendingRevokeCode || revokingCodeId === pendingRevokeCode?.id}
              >
                {pendingRevokeCode && revokingCodeId === pendingRevokeCode.id ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={[styles.modalButtonText, { color: '#fff' }]}>Revoke</Text>
                )}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
});

TenantJoinCodeManager.displayName = 'TenantJoinCodeManager';

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
    marginBottom: 12,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  iconButton: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: 1,
  },
  iconButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  description: {
    fontSize: 13,
    marginBottom: 12,
  },
  limitContext: {
    fontSize: 12,
    marginBottom: 12,
  },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -4,
    marginBottom: 12,
  },
  filterChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginHorizontal: 4,
    marginBottom: 8,
  },
  filterChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  expiryRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  expiryChip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  expiryChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    borderRadius: 10,
    marginBottom: 12,
  },
  alertText: {
    marginLeft: 8,
    fontSize: 13,
    flex: 1,
  },
  emptyState: {
    paddingVertical: 12,
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 4,
  },
  emptySubtitle: {
    fontSize: 13,
  },
  codeCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  codeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  codeValue: {
    fontSize: 16,
    fontWeight: '600',
  },
  codeMeta: {
    fontSize: 12,
  },
  codeMetaRow: {
    marginTop: 8,
    gap: 4,
  },
  pendingBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginTop: 8,
  },
  pendingBadgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  statusChip: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  statusChipText: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  actionsRow: {
    flexDirection: 'row',
    marginTop: 12,
    gap: 10,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
  },
  actionButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  loadMoreButton: {
    marginTop: 4,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadMoreButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  filterResetButton: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  filterResetText: {
    fontSize: 13,
    fontWeight: '600',
  },
  modalHint: {
    fontSize: 12,
    marginBottom: 16,
  },
  modalLimitBanner: {
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 16,
  },
  modalLimitBannerText: {
    fontSize: 12,
    fontWeight: '600',
  },
  listWindow: {
    maxHeight: 360,
    width: '100%',
    overflow: 'hidden',
  },
  listWindowScroll: {
    flexGrow: 0,
  },
  listWindowContent: {
    paddingBottom: 8,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalCard: {
    width: '100%',
    maxWidth: 360,
    borderRadius: 16,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    marginBottom: 8,
  },
  modalMessage: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 20,
  },
  modalActions: {
    flexDirection: 'row',
    gap: 12,
  },
  modalButton: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modalDangerButton: {
    borderWidth: 0,
  },
  modalButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

export default TenantJoinCodeManager;
