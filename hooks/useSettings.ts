import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback } from 'react';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
import * as Updates from 'expo-updates';
import { settingsService, AppSettings } from '../services/settingsService';
import { useTenant } from './useTenantContext';

export interface UseSettingsReturn {
  settings: AppSettings | null;
  loading: boolean;
  error: string | null;
  contactInfo: {
    supportEmail: string;
    supportPhone: string;
    whatsappNumber: string;
    bugReportFormUrl: string;
  } | null;
  appInfo: AppSettings['appInfo'] | null;
  supportInfo: AppSettings['supportInfo'] | null;
  updatedAt: string | null;
  refreshSettings: () => Promise<void>;
}

export const useSettings = (): UseSettingsReturn => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contactInfo, setContactInfo] = useState<UseSettingsReturn['contactInfo']>(null);
  const [appInfo, setAppInfo] = useState<AppSettings['appInfo'] | null>(null);
  const [supportInfo, setSupportInfo] = useState<AppSettings['supportInfo'] | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const { activeTenant } = useTenant();

  const loadSettings = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      logger.debug('🔄 Loading settings from Firestore...');

      // Load all settings
      const settingsData = await settingsService.getSettings();
      logger.debug('📄 Settings data loaded:', settingsData ? 'SUCCESS' : 'NULL');
      setSettings(settingsData);

      // Extract updatedAt timestamp (check if it exists on the raw document)
      setUpdatedAt((settingsData as any)?.updatedAt || null);

      // Extract specific data
      const contact = await settingsService.getContactInfo();
      logger.debug('📞 Contact info loaded:', contact);
      setContactInfo(contact);

  const appData = await settingsService.getAppInfo();
  logger.debug('📱 App info loaded:', appData ? 'SUCCESS' : 'NULL');
  // Derive version/build from build metadata (web uses env; native uses Application APIs)
  const envAppVersion = (process.env.EXPO_PUBLIC_APP_VERSION || '').trim();
  const envAppBuild = (process.env.EXPO_PUBLIC_APP_BUILD || '').trim();
  const effectiveVersion = Platform.OS === 'web'
    ? (envAppVersion || appData?.version)
    : (Application.nativeApplicationVersion || envAppVersion || appData?.version);
  const effectiveBuild = Platform.OS === 'web'
    ? (envAppBuild || appData?.build)
    : (Application.nativeBuildVersion || envAppBuild || appData?.build);
  // Derive release month from build metadata when available (env > OTA manifest > Firestore)
  const envRelease = (process.env.EXPO_PUBLIC_RELEASE_MONTH || process.env.EXPO_PUBLIC_RELEASE_DATE || '').trim();
  let otaCreatedAt: string | undefined;
  try {
    // createdAt is present when using EAS Updates; guard for web/dev
    otaCreatedAt = (Updates as any)?.manifest?.createdAt as string | undefined;
  } catch {
    otaCreatedAt = undefined;
  }
  const formattedOtaMonth = otaCreatedAt ? new Date(otaCreatedAt).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : undefined;
  // Strictly build-only: do NOT fall back to Firestore. If not available, leave empty.
  const effectiveReleaseDate = envRelease || formattedOtaMonth || '';
  const mergedAppInfo = appData
    ? { ...appData, version: effectiveVersion as string, build: effectiveBuild as string, releaseDate: effectiveReleaseDate as string }
    : appData;
  setAppInfo(mergedAppInfo);

      const supportData = await settingsService.getSupportInfo();
      logger.debug('🆘 Support info loaded:', supportData);
      setSupportInfo(supportData);

      logger.debug('✅ Settings loaded successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load settings';
      setError(errorMessage);
      logger.error('❌ Error loading settings:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshSettings = useCallback(async () => {
    settingsService.clearCache();
    await loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const tenantCoachingName = activeTenant?.name?.trim();

  useEffect(() => {
    if (typeof tenantCoachingName === 'undefined') {
      return;
    }
    setSettings((prev) => {
      if (!prev) {
        return prev;
      }
      if (prev.coachingName === tenantCoachingName) {
        return prev;
      }
      return { ...prev, coachingName: tenantCoachingName };
    });
  }, [tenantCoachingName]);

  return {
    settings,
    loading,
    error,
    contactInfo,
    appInfo,
    supportInfo,
    updatedAt,
    refreshSettings
  };
};
