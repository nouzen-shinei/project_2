import { logger } from '@/lib/logger';
import { useState, useEffect, useCallback, useRef } from 'react';
import { reminderSettingsService, ReminderSettings, DEFAULT_REMINDER_SETTINGS } from '../services/reminderSettingsService';
import { useAuth } from './useAuthUnified';
import { useTenant } from './useTenantContext';

export function useReminderSettings() {
  const { user } = useAuth();
  const { activeTenant } = useTenant();
  const tenantId = activeTenant?.id;
  const [settings, setSettings] = useState<ReminderSettings>(DEFAULT_REMINDER_SETTINGS);
  const [localSettings, setLocalSettings] = useState<ReminderSettings>(DEFAULT_REMINDER_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasUnsavedRef = useRef(false);
  const requireTenantMessage = 'Select a coaching center to configure reminder settings';

  useEffect(() => {
    hasUnsavedRef.current = hasUnsavedChanges;
  }, [hasUnsavedChanges]);

  const ensureTenant = useCallback(() => {
    if (!tenantId) {
      throw new Error(requireTenantMessage);
    }
    return tenantId;
  }, [tenantId]);

  // Load settings when user is available
  useEffect(() => {
    if (!user?.uid) {
      setSettings(DEFAULT_REMINDER_SETTINGS);
      setLocalSettings(DEFAULT_REMINDER_SETTINGS);
      setHasUnsavedChanges(false);
      setLoading(false);
      return;
    }

    if (!tenantId) {
      setSettings(DEFAULT_REMINDER_SETTINGS);
      setLocalSettings(DEFAULT_REMINDER_SETTINGS);
      setHasUnsavedChanges(false);
      setError(requireTenantMessage);
      setLoading(false);
      reminderSettingsService.cleanup();
      return;
    }

    let unsubscribe: (() => void) | null = null;

    const loadAndSubscribe = async () => {
      try {
        setLoading(true);
        setError(null);

        // Load initial settings
        const initialSettings = await reminderSettingsService.loadSettings(tenantId);
        setSettings(initialSettings);
        setLocalSettings(initialSettings);
        setHasUnsavedChanges(false);

        // Subscribe to real-time updates
        unsubscribe = reminderSettingsService.subscribeToSettings(tenantId, (updatedSettings) => {
          setSettings(updatedSettings);
          // Only update local settings if there are no unsaved changes
          if (!hasUnsavedRef.current) {
            setLocalSettings(updatedSettings);
          }
        });

        setLoading(false);
      } catch (err) {
        logger.error('Error loading reminder settings:', err);
        setError(err instanceof Error ? err.message : 'Failed to load settings');
        setSettings(DEFAULT_REMINDER_SETTINGS);
        setLocalSettings(DEFAULT_REMINDER_SETTINGS);
        setLoading(false);
      }
    };

    loadAndSubscribe();

    // Cleanup subscription on unmount or user change
    return () => {
      if (unsubscribe) {
        unsubscribe();
      }
      reminderSettingsService.cleanup(tenantId);
    };
  }, [user?.uid, tenantId, requireTenantMessage]);

  // Update a single setting locally (not saved until manual save)
  const updateLocalSetting = useCallback(<K extends keyof ReminderSettings>(
    key: K,
    value: ReminderSettings[K]
  ): void => {
    setLocalSettings(prev => {
      const newSettings = { ...prev, [key]: value };
      
      // Check if settings have changed from saved version
      const hasChanges = JSON.stringify(newSettings) !== JSON.stringify(settings);
      setHasUnsavedChanges(hasChanges);
      
      return newSettings;
    });
  }, [settings]);

  // Save all local settings to Firestore
  const saveSettings = useCallback(async (): Promise<boolean> => {
    if (!user?.uid) {
      logger.error('Cannot save settings: User not authenticated');
      return false;
    }

    if (!hasUnsavedChanges) {
      logger.debug('No changes to save');
      return true;
    }

    try {
      const scopedTenantId = ensureTenant();
      setSaving(true);
      setError(null);
      
      const success = await reminderSettingsService.saveSettings(scopedTenantId, localSettings);
      
      if (success) {
        setSettings(localSettings);
        setHasUnsavedChanges(false);
        logger.debug('Settings saved successfully');
      } else {
        setError('Failed to save settings');
      }
      
      setSaving(false);
      return success;
    } catch (err) {
      logger.error('Error saving settings:', err);
      setError(err instanceof Error ? err.message : 'Failed to save settings');
      setSaving(false);
      return false;
    }
  }, [user?.uid, localSettings, hasUnsavedChanges, ensureTenant]);

  // Discard local changes and revert to saved settings
  const discardChanges = useCallback((): void => {
    setLocalSettings(settings);
    setHasUnsavedChanges(false);
  }, [settings]);

  // Update a single setting (keeping for backward compatibility, but will auto-save)
  const updateSetting = useCallback(async <K extends keyof ReminderSettings>(
    key: K,
    value: ReminderSettings[K]
  ): Promise<boolean> => {
    if (!user?.uid) {
      logger.error('Cannot update settings: User not authenticated');
      return false;
    }

    try {
      const scopedTenantId = ensureTenant();
      // Optimistically update local state
      setSettings(prev => ({ ...prev, [key]: value }));
      
      // Save to Firestore
      const success = await reminderSettingsService.updateSetting(scopedTenantId, key, value);
      
      if (!success) {
        // Revert on failure
        const cachedSettings = reminderSettingsService.getCachedSettings(scopedTenantId);
        if (cachedSettings) {
          setSettings(cachedSettings);
        }
      }
      
      return success;
    } catch (err) {
      logger.error('Error updating setting:', err);
      
      // Revert on error
      if (tenantId) {
        const cachedSettings = reminderSettingsService.getCachedSettings(tenantId);
        if (cachedSettings) {
          setSettings(cachedSettings);
        }
      }
      return false;
    }
  }, [user?.uid, ensureTenant, tenantId]);

  // Update multiple settings
  const updateMultipleSettings = useCallback(async (updates: Partial<ReminderSettings>): Promise<boolean> => {
    if (!user?.uid) {
      logger.error('Cannot update settings: User not authenticated');
      return false;
    }

    try {
      const scopedTenantId = ensureTenant();
      // Optimistically update local state
      setSettings(prev => ({ ...prev, ...updates }));
      
      // Save to Firestore
      const success = await reminderSettingsService.updateMultipleSettings(scopedTenantId, updates);
      
      if (!success) {
        // Revert on failure
        const cachedSettings = reminderSettingsService.getCachedSettings(scopedTenantId);
        if (cachedSettings) {
          setSettings(cachedSettings);
        }
      }
      
      return success;
    } catch (err) {
      logger.error('Error updating multiple settings:', err);
      
      // Revert on error
      if (tenantId) {
        const cachedSettings = reminderSettingsService.getCachedSettings(tenantId);
        if (cachedSettings) {
          setSettings(cachedSettings);
        }
      }
      return false;
    }
  }, [user?.uid, ensureTenant, tenantId]);

  // Reset to defaults
  const resetToDefaults = useCallback(async (): Promise<boolean> => {
    if (!user?.uid) {
      logger.error('Cannot reset settings: User not authenticated');
      return false;
    }

    try {
      const scopedTenantId = ensureTenant();
      const success = await reminderSettingsService.resetToDefaults(scopedTenantId);
      if (success) {
        setSettings(DEFAULT_REMINDER_SETTINGS);
      }
      return success;
    } catch (err) {
      logger.error('Error resetting settings:', err);
      return false;
    }
  }, [user?.uid, ensureTenant]);

  return {
    settings: settings, // Return saved settings for actual use
    localSettings: localSettings, // Return local settings for UI display
    loading,
    error,
    updateSetting,
    updateLocalSetting,
    saveSettings,
    discardChanges,
    hasUnsavedChanges,
    saving,
    updateMultipleSettings,
    resetToDefaults,
    
    // Convenience getters
    isAuthenticated: !!user?.uid,
  };
}
