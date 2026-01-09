import AsyncStorage from '@react-native-async-storage/async-storage';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';

import { logger } from '@/lib/logger';
import { firestore } from '../config/firebase';
import { internalTokenManager } from './internalTokenManager';

export type RuntimeEndpoints = {
  apiBaseUrl?: string;
  emailApiBaseUrl?: string;
  notificationsApiBaseUrl?: string;
  wabaApiBaseUrl?: string;
  chatApiBaseUrl?: string;
  updatedAt?: string;
};

const STORAGE_KEY = 'runtimeEndpointsCacheV1';
const COLLECTION = 'appSettings';
const DOC_ID = 'runtimeEndpoints';
const FALLBACK_DOC_ID = 'globalSettings';

function normalizeHttpUrl(input?: unknown): string | undefined {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return undefined;
  const withoutTrailingSlash = raw.replace(/\/+$/, '');
  if (withoutTrailingSlash.startsWith('http://') || withoutTrailingSlash.startsWith('https://')) {
    return withoutTrailingSlash;
  }
  return undefined;
}

function mergeNormalized(raw: any): RuntimeEndpoints {
  return {
    apiBaseUrl: normalizeHttpUrl(raw?.apiBaseUrl),
    emailApiBaseUrl: normalizeHttpUrl(raw?.emailApiBaseUrl),
    notificationsApiBaseUrl: normalizeHttpUrl(raw?.notificationsApiBaseUrl),
    wabaApiBaseUrl: normalizeHttpUrl(raw?.wabaApiBaseUrl),
    chatApiBaseUrl: normalizeHttpUrl(raw?.chatApiBaseUrl),
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : undefined,
  };
}

class RuntimeEndpointsService {
  private cached: RuntimeEndpoints | null = null;
  private started = false;
  private unsub?: () => void;

  async init(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.loadFromStorage();
    await this.refreshFromFirestoreOnce();
    this.startListener();
  }

  stop(): void {
    try {
      this.unsub?.();
    } finally {
      this.unsub = undefined;
      this.started = false;
    }
  }

  getSnapshot(): RuntimeEndpoints {
    return this.cached || {};
  }

  getPreferredBackendBaseUrl(): string | undefined {
    const s = this.getSnapshot();
    return s.apiBaseUrl || s.notificationsApiBaseUrl || s.wabaApiBaseUrl || s.chatApiBaseUrl;
  }

  getEmailBackendBaseUrl(): string | undefined {
    const s = this.getSnapshot();
    return s.emailApiBaseUrl || s.apiBaseUrl || s.notificationsApiBaseUrl || s.wabaApiBaseUrl || s.chatApiBaseUrl;
  }

  requirePreferredBackendBaseUrl(): string {
    const base = this.getPreferredBackendBaseUrl();
    if (!base) {
      throw new Error(
        `Backend URL not configured. Set Firestore ${COLLECTION}/${DOC_ID}.apiBaseUrl (or notificationsApiBaseUrl / wabaApiBaseUrl / chatApiBaseUrl).`,
      );
    }
    return base;
  }

  requireEmailBackendBaseUrl(): string {
    const base = this.getEmailBackendBaseUrl();
    if (!base) {
      throw new Error(
        `Email backend URL not configured. Set Firestore ${COLLECTION}/${DOC_ID}.emailApiBaseUrl (or apiBaseUrl).`,
      );
    }
    return base;
  }

  private async loadFromStorage(): Promise<void> {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const normalized = mergeNormalized(parsed);
      if (Object.keys(normalized).some((k) => (normalized as any)[k])) {
        this.cached = normalized;
        this.applySideEffects(normalized);
      }
    } catch (e) {
      logger.warn('[runtimeEndpoints] failed to load cache', e);
    }
  }

  private async persistToStorage(value: RuntimeEndpoints): Promise<void> {
    try {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch (e) {
      logger.warn('[runtimeEndpoints] failed to persist cache', e);
    }
  }

  private async refreshFromFirestoreOnce(): Promise<void> {
    try {
      const ref = doc(firestore, COLLECTION, DOC_ID);
      const snap = await getDoc(ref);
      if (snap.exists()) {
        const normalized = mergeNormalized(snap.data());
        this.setCached(normalized);
        return;
      }

      // Backward compatibility: if someone stored endpoints in appSettings/globalSettings
      const fallbackRef = doc(firestore, COLLECTION, FALLBACK_DOC_ID);
      const fallbackSnap = await getDoc(fallbackRef);
      if (fallbackSnap.exists()) {
        const data = fallbackSnap.data();
        const normalized = mergeNormalized(data?.runtimeEndpoints || data?.endpoints || data);
        this.setCached(normalized);
      }
    } catch (e) {
      logger.warn('[runtimeEndpoints] failed to refresh from firestore', e);
    }
  }

  private startListener(): void {
    try {
      const ref = doc(firestore, COLLECTION, DOC_ID);
      this.unsub = onSnapshot(
        ref,
        (snap) => {
          if (!snap.exists()) return;
          const normalized = mergeNormalized(snap.data());
          this.setCached(normalized);
        },
        (err) => {
          logger.warn('[runtimeEndpoints] snapshot error', err);
        },
      );
    } catch (e) {
      logger.warn('[runtimeEndpoints] failed to start listener', e);
    }
  }

  private setCached(value: RuntimeEndpoints): void {
    // Avoid churn if nothing meaningful is set
    if (!Object.values(value).some(Boolean)) return;
    this.cached = value;
    this.applySideEffects(value);
    void this.persistToStorage(value);
  }

  private applySideEffects(value: RuntimeEndpoints): void {
    const base = value.apiBaseUrl;
    if (base) {
      internalTokenManager.setBaseUrl(base);
    }
  }
}

export const runtimeEndpoints = new RuntimeEndpointsService();
