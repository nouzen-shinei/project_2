import { logger } from '@/lib/logger';
import { doc, getDoc, setDoc, onSnapshot } from 'firebase/firestore';
import { firestore } from '../config/firebase';

export interface ReminderSettings {
  // Channel enablement (admin-controlled)
  // Default is enabled for all channels.
  enabledChannels?: {
    email?: boolean;
    sms?: boolean;
    whatsapp?: boolean;
    voice?: boolean;
  };

  // UI behavior (admin-controlled)
  // Default: disabled channels are shown but not selectable.
  hideDisabledReminderTypes?: boolean;

  // Optional per-channel message shown when a channel is disabled.
  // Admin can set globally and/or per-tenant.
  channelMessages?: {
    email?: string;
    sms?: string;
    whatsapp?: string;
    voice?: string;
  };

  // Coaching and Teacher Settings
  showCoachingName: boolean;
  useCustomCoachingName: boolean;
  customCoachingName: string;
  showTeacherName: boolean;
  
  // Greeting Settings
  addGreetings: boolean;
  useCustomGreetings: boolean;
  customGreetingsEnglish: string;
  customGreetingsHindi: string;
  
  // Language and Voice Settings
  selectedLanguage: 'english' | 'hindi' | 'both';
  // Curated Text-to-Speech voice IDs from twilio_voices.txt
  // English (India) options
  englishVoice:
    | 'google-en-in-standard-a'
    | 'google-en-in-standard-b'
    | 'google-en-in-standard-c'
    | 'google-en-in-standard-d'
    | 'google-en-in-standard-e'
    | 'google-en-in-standard-f'
    | 'polly-aditi' // bilingual
    | 'polly-raveena';
  // Hindi (India) options
  hindiVoice:
    | 'google-hi-in-standard-a'
    | 'google-hi-in-standard-b'
    | 'google-hi-in-standard-c'
    | 'google-hi-in-standard-d'
    | 'google-hi-in-standard-e'
    | 'google-hi-in-standard-f'
    | 'polly-aditi'; // bilingual
  languageOrder: 'hindi-first' | 'english-first';
  
  // Timestamps
  createdAt?: string;
  updatedAt?: string;
}

// Helper: migrate legacy voice ids to curated ids
function migrateVoice(val: any, lang: 'en' | 'hi'): any {
  if (!val) return undefined;
  const v = String(val).toLowerCase();
  if (lang === 'en') {
    if (v === 'alice' || v === 'polly') return 'polly-raveena';
  } else {
    if (v === 'aditi') return 'polly-aditi';
    if (v === 'ravi') return 'google-hi-in-standard-b'; // male Hindi
  }
  return val;
}

// Default settings
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabledChannels: {
    email: true,
    sms: true,
    whatsapp: true,
    voice: true,
  },
  hideDisabledReminderTypes: false,
  channelMessages: {},
  showCoachingName: true,
  useCustomCoachingName: false,
  customCoachingName: '',
  showTeacherName: true,
  addGreetings: true,
  useCustomGreetings: false,
  customGreetingsEnglish: '',
  customGreetingsHindi: '',
  selectedLanguage: 'english',
  // Defaults: Indian English female (Raveena) and Hindi bilingual (Aditi)
  englishVoice: 'polly-raveena',
  hindiVoice: 'polly-aditi',
  languageOrder: 'hindi-first',
};

class ReminderSettingsService {
  private settingsCache = new Map<string, ReminderSettings>();
  private unsubscribeMap = new Map<string, () => void>();

  // These keys are controlled from the admin console/backend and should not be
  // written by the mobile app to avoid clobbering admin policy.
  private stripAdminControlledFields(settings: ReminderSettings): Omit<ReminderSettings, 'enabledChannels' | 'hideDisabledReminderTypes' | 'channelMessages'> {
    const { enabledChannels: _enabledChannels, hideDisabledReminderTypes: _hide, channelMessages: _messages, ...rest } =
      settings as any;
    return rest;
  }

  private ensureTenantId(tenantId: string): string {
    if (!tenantId) {
      throw new Error('tenantId is required for reminder settings operations');
    }
    return tenantId;
  }

  private getSettingsRef(tenantId: string) {
    return doc(firestore, 'tenants', this.ensureTenantId(tenantId), 'settings', 'reminders');
  }

  async loadSettings(tenantId: string): Promise<ReminderSettings> {
    try {
      const settingsRef = this.getSettingsRef(tenantId);
      const settingsDoc = await getDoc(settingsRef);

      if (settingsDoc.exists()) {
        const raw = settingsDoc.data() as Partial<ReminderSettings>;
        const migratedEnglish = migrateVoice(raw.englishVoice, 'en');
        const migratedHindi = migrateVoice(raw.hindiVoice, 'hi');
        const data: ReminderSettings = {
          ...DEFAULT_REMINDER_SETTINGS,
          ...(raw as any),
          englishVoice: migratedEnglish || DEFAULT_REMINDER_SETTINGS.englishVoice,
          hindiVoice: migratedHindi || DEFAULT_REMINDER_SETTINGS.hindiVoice,
        };

        // Preserve "unset" for tenant-level hide flag so global policy can apply.
        // When absent in Firestore, treat as undefined (inherit) rather than default false.
        data.hideDisabledReminderTypes =
          typeof (raw as any).hideDisabledReminderTypes === 'boolean' ? (raw as any).hideDisabledReminderTypes : undefined;

        const needsWriteBack =
          (raw.englishVoice && migratedEnglish && raw.englishVoice !== migratedEnglish) ||
          (raw.hindiVoice && migratedHindi && raw.hindiVoice !== migratedHindi);
        if (needsWriteBack) {
          try {
            await setDoc(
              settingsRef,
              {
                englishVoice: data.englishVoice,
                hindiVoice: data.hindiVoice,
              },
              { merge: true },
            );
          } catch (writeError) {
            logger.warn('Could not write back migrated voice settings:', writeError);
          }
        }

        this.settingsCache.set(tenantId, data);
        logger.debug('Loaded reminder settings from Firestore:', data);
        return data;
      }

      logger.debug('No reminder settings found for tenant, using defaults');
      await this.saveSettings(tenantId, DEFAULT_REMINDER_SETTINGS);
      this.settingsCache.set(tenantId, DEFAULT_REMINDER_SETTINGS);
      return DEFAULT_REMINDER_SETTINGS;
    } catch (error) {
      logger.error('Error loading reminder settings:', error);
      const cached = this.settingsCache.get(tenantId) || DEFAULT_REMINDER_SETTINGS;
      return cached;
    }
  }

  async saveSettings(tenantId: string, settings: Partial<ReminderSettings>): Promise<boolean> {
    try {
      const settingsRef = this.getSettingsRef(tenantId);
      const timestamp = new Date().toISOString();
      const existing = this.settingsCache.get(tenantId);

      const settingsToSave: ReminderSettings = {
        ...DEFAULT_REMINDER_SETTINGS,
        ...existing,
        ...settings,
        updatedAt: timestamp,
      };

      if (!settingsToSave.createdAt) {
        const serverSnapshot = await getDoc(settingsRef);
        if (serverSnapshot.exists()) {
          const data = serverSnapshot.data() as ReminderSettings;
          settingsToSave.createdAt = data.createdAt || timestamp;
        } else {
          settingsToSave.createdAt = timestamp;
        }
      }

      await setDoc(settingsRef, this.stripAdminControlledFields(settingsToSave) as any, { merge: true });
      this.settingsCache.set(tenantId, settingsToSave);
      logger.debug('Reminder settings saved to Firestore:', settingsToSave);
      return true;
    } catch (error) {
      logger.error('Error saving reminder settings:', error);
      return false;
    }
  }

  subscribeToSettings(tenantId: string, onUpdate: (settings: ReminderSettings) => void): () => void {
    try {
      const settingsRef = this.getSettingsRef(tenantId);
      this.unsubscribeMap.get(tenantId)?.();

      const unsubscribe = onSnapshot(
        settingsRef,
        (snapshot) => {
          if (!snapshot.exists()) {
            onUpdate(DEFAULT_REMINDER_SETTINGS);
            return;
          }

          const raw = snapshot.data() as Partial<ReminderSettings>;
          const settings = {
            ...DEFAULT_REMINDER_SETTINGS,
            ...(raw as any),
            englishVoice: migrateVoice(raw.englishVoice, 'en') || DEFAULT_REMINDER_SETTINGS.englishVoice,
            hindiVoice: migrateVoice(raw.hindiVoice, 'hi') || DEFAULT_REMINDER_SETTINGS.hindiVoice,
          } as ReminderSettings;

          settings.hideDisabledReminderTypes =
            typeof (raw as any).hideDisabledReminderTypes === 'boolean' ? (raw as any).hideDisabledReminderTypes : undefined;

          this.settingsCache.set(tenantId, settings);
          onUpdate(settings);
          logger.debug('Real-time reminder settings update received:', settings);
        },
        (error) => {
          logger.error('Error subscribing to reminder settings:', error);
          onUpdate(DEFAULT_REMINDER_SETTINGS);
        },
      );

      this.unsubscribeMap.set(tenantId, unsubscribe);
      return () => {
        unsubscribe();
        this.unsubscribeMap.delete(tenantId);
      };
    } catch (error) {
      logger.error('Error setting up reminder settings subscription:', error);
      return () => {};
    }
  }

  async updateSetting<K extends keyof ReminderSettings>(
    tenantId: string,
    key: K,
    value: ReminderSettings[K],
  ): Promise<boolean> {
    const update = { [key]: value } as Partial<ReminderSettings>;
    return this.saveSettings(tenantId, update);
  }

  async updateMultipleSettings(tenantId: string, updates: Partial<ReminderSettings>): Promise<boolean> {
    return this.saveSettings(tenantId, updates);
  }

  getCachedSettings(tenantId: string): ReminderSettings | null {
    return this.settingsCache.get(tenantId) || null;
  }

  cleanup(tenantId?: string): void {
    if (tenantId) {
      this.unsubscribeMap.get(tenantId)?.();
      this.unsubscribeMap.delete(tenantId);
      return;
    }

    this.unsubscribeMap.forEach((unsubscribe) => unsubscribe());
    this.unsubscribeMap.clear();
  }

  async resetToDefaults(tenantId: string): Promise<boolean> {
    try {
      const settingsRef = this.getSettingsRef(tenantId);
      const timestamp = new Date().toISOString();
      const current = this.settingsCache.get(tenantId);

      const defaultSettings: ReminderSettings = {
        ...DEFAULT_REMINDER_SETTINGS,
        createdAt: current?.createdAt || timestamp,
        updatedAt: timestamp,
      };

      await setDoc(settingsRef, this.stripAdminControlledFields(defaultSettings) as any, { merge: true });
      this.settingsCache.set(tenantId, defaultSettings);
      logger.debug('Reminder settings reset to defaults for tenant:', tenantId);
      return true;
    } catch (error) {
      logger.error('Error resetting reminder settings:', error);
      return false;
    }
  }
}

export const reminderSettingsService = new ReminderSettingsService();
