import AsyncStorage from '@react-native-async-storage/async-storage';

import { tenantBackendClient, TenantJoinCodeClaimResponse } from './tenantBackendClient';

const REVIEWER_QUICK_JOIN_PENDING_KEY = 'reviewer_quick_join_pending';
const REVIEWER_QUICK_JOIN_FALLBACK_CENTER_NAME = 'legacy-coachin';

const normalizeEnvCode = (raw: string | undefined): string =>
  (raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

const parseBooleanEnv = (raw: string | undefined): boolean => {
  const value = (raw || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
};

export const getReviewerQuickJoinCode = (): string => {
  return normalizeEnvCode(process.env.EXPO_PUBLIC_REVIEWER_QUICK_JOIN_CODE);
};

export const isReviewerQuickJoinEnabled = (): boolean => {
  const code = getReviewerQuickJoinCode();
  if (!code) {
    return false;
  }
  return parseBooleanEnv(process.env.EXPO_PUBLIC_REVIEWER_QUICK_JOIN_ENABLED);
};

export const getReviewerQuickJoinCenterName = (): string => {
  const configured = (process.env.EXPO_PUBLIC_REVIEWER_QUICK_JOIN_CENTER_NAME || '').trim();
  return configured || REVIEWER_QUICK_JOIN_FALLBACK_CENTER_NAME;
};

export async function markReviewerQuickJoinPending(): Promise<void> {
  await AsyncStorage.setItem(REVIEWER_QUICK_JOIN_PENDING_KEY, '1');
}

export async function clearReviewerQuickJoinPending(): Promise<void> {
  await AsyncStorage.removeItem(REVIEWER_QUICK_JOIN_PENDING_KEY);
}

export async function consumeReviewerQuickJoinPending(): Promise<boolean> {
  const value = await AsyncStorage.getItem(REVIEWER_QUICK_JOIN_PENDING_KEY);
  if (value !== '1') {
    return false;
  }
  await AsyncStorage.removeItem(REVIEWER_QUICK_JOIN_PENDING_KEY);
  return true;
}

export async function claimReviewerQuickJoin(displayName?: string): Promise<TenantJoinCodeClaimResponse> {
  if (!isReviewerQuickJoinEnabled()) {
    throw new Error('Reviewer quick join is disabled.');
  }
  const code = getReviewerQuickJoinCode();
  if (!code) {
    throw new Error('Reviewer quick join code is not configured.');
  }

  return tenantBackendClient.claimJoinCode({
    code,
    displayName,
    message: 'reviewer_quick_join',
  });
}
