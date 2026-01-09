import Constants from 'expo-constants';
import { logger } from '@/lib/logger';

type MaybeString = string | null | undefined;

const coalesce = (...candidates: MaybeString[]): string | undefined => {
  for (const value of candidates) {
    if (value && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
};

/**
 * Resolve the Expo project ID required for retrieving Expo push tokens.
 * Falls back through environment variables and Constants metadata.
 */
export const resolveExpoProjectId = (): string | undefined => {
  const envProjectId = coalesce(
    process.env.EXPO_PUBLIC_EAS_PROJECT_ID,
    process.env.EAS_PROJECT_ID,
    process.env.EAS_BUILD_PROJECT_ID,
    process.env.EXPO_PUBLIC_PROJECT_ID
  );

  // Access potential locations in Constants without assuming schema stability
  const constantsAny = Constants as unknown as {
    expoConfig?: any;
    easConfig?: any;
    manifest?: any;
    manifest2?: any;
  };

  const constantsProjectId = coalesce(
    constantsAny?.expoConfig?.extra?.eas?.projectId,
    constantsAny?.easConfig?.projectId,
    constantsAny?.expoConfig?.projectId,
    constantsAny?.manifest2?.extra?.eas?.projectId,
    constantsAny?.manifest?.extra?.eas?.projectId
  );

  const resolved = coalesce(envProjectId, constantsProjectId);
  if (resolved) {
    return resolved;
  }

  const firebaseFallback = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
  if (firebaseFallback) {
    logger.warn(
      'Expo project ID not found via EAS metadata; falling back to EXPO_PUBLIC_FIREBASE_PROJECT_ID. Configure EXPO_PUBLIC_EAS_PROJECT_ID or EAS project metadata for reliable push notifications.'
    );
    return firebaseFallback;
  }

  logger.error('Unable to resolve Expo project ID. Push notifications will remain disabled until it is configured.');
  return undefined;
};
