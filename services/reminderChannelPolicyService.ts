import { logger } from '@/lib/logger';
import { authService } from '@/hooks/useAuthUnified';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { firestore } from '../config/firebase';

export type ReminderChannelKey = 'email' | 'sms' | 'whatsapp' | 'voice';

export interface ReminderChannelPolicyDoc {
  enabledChannels?: Partial<Record<ReminderChannelKey, boolean>>;
  channelMessages?: Partial<Record<ReminderChannelKey, string>>;
  hideDisabledReminderTypes?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export const DEFAULT_REMINDER_CHANNEL_POLICY: Required<
  Pick<ReminderChannelPolicyDoc, 'enabledChannels' | 'channelMessages' | 'hideDisabledReminderTypes'>
> = {
  enabledChannels: {
    email: true,
    sms: true,
    whatsapp: true,
    voice: true,
  },
  channelMessages: {},
  hideDisabledReminderTypes: false,
};

class ReminderChannelPolicyService {
  private cached: ReminderChannelPolicyDoc | null = null;
  private unsubscribe: (() => void) | null = null;
  private lastCallback: ((doc: ReminderChannelPolicyDoc) => void) | null = null;
  private reinitUnsubscribe: (() => void) | null = null;

  private getRef() {
    return doc(firestore, 'appSettings', 'reminderChannels');
  }

  async load(): Promise<ReminderChannelPolicyDoc> {
    try {
      const ref = this.getRef();
      const snap = await getDoc(ref);
      const docData = (snap.exists() ? (snap.data() as ReminderChannelPolicyDoc) : null) ?? {};
      const merged: ReminderChannelPolicyDoc = {
        ...DEFAULT_REMINDER_CHANNEL_POLICY,
        ...docData,
        enabledChannels: {
          ...DEFAULT_REMINDER_CHANNEL_POLICY.enabledChannels,
          ...(docData.enabledChannels ?? {}),
        },
        channelMessages: {
          ...(docData.channelMessages ?? {}),
        },
      };
      this.cached = merged;
      return merged;
    } catch (error) {
      logger.error('Error loading global reminder channel policy:', error);
      return this.cached ?? DEFAULT_REMINDER_CHANNEL_POLICY;
    }
  }

  private ensureReinitRegistration(): void {
    if (this.reinitUnsubscribe) return;
    this.reinitUnsubscribe = authService.registerFirestoreReinit?.((context) => {
      if (this.lastCallback) {
        this.attachSubscription(this.lastCallback, context || 'reinit');
      }
    }) || null;
  }

  private attachSubscription(onUpdate: (doc: ReminderChannelPolicyDoc) => void, context?: string): () => void {
    this.unsubscribe?.();
    const ref = this.getRef();
    const unsubscribe = onSnapshot(
      ref,
      (snapshot) => {
        const docData = (snapshot.exists() ? (snapshot.data() as ReminderChannelPolicyDoc) : null) ?? {};
        const merged: ReminderChannelPolicyDoc = {
          ...DEFAULT_REMINDER_CHANNEL_POLICY,
          ...docData,
          enabledChannels: {
            ...DEFAULT_REMINDER_CHANNEL_POLICY.enabledChannels,
            ...(docData.enabledChannels ?? {}),
          },
          channelMessages: {
            ...(docData.channelMessages ?? {}),
          },
        };
        this.cached = merged;
        onUpdate(merged);
      },
      (error) => {
        logger.error('Error subscribing to global reminder channel policy:', error);
        onUpdate(this.cached ?? DEFAULT_REMINDER_CHANNEL_POLICY);
      },
    );

    this.unsubscribe = unsubscribe;

    if (context) {
      logger.debug('ReminderChannelPolicyService: reattached subscription', { context });
    }

    return () => {
      unsubscribe();
      if (this.unsubscribe === unsubscribe) {
        this.unsubscribe = null;
      }
    };
  }

  subscribe(onUpdate: (doc: ReminderChannelPolicyDoc) => void): () => void {
    try {
      this.lastCallback = onUpdate;
      this.ensureReinitRegistration();
      return this.attachSubscription(onUpdate, 'initial');
    } catch (error) {
      logger.error('Error setting up global reminder channel policy subscription:', error);
      return () => {};
    }
  }
}

export const reminderChannelPolicyService = new ReminderChannelPolicyService();
