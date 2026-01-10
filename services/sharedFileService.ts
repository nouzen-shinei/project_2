import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import { logger } from '@/lib/logger';
import { runtimeEndpoints } from '@/services/runtimeEndpoints';
import { internalTokenManager } from '@/services/internalTokenManager';
import { tenantService } from '@/services/tenantService';

export type SharedFileRecord = {
  token: string;
  tenantId?: string;
  createdAt?: string;
  createdByEmail?: string;
  file?: {
    url: string;
    fileName: string;
    fileType?: string;
    fileSize?: number;
    thumbnailUrl?: string;
  };
};

const looksLikeGarbageFileName = (value?: string | null): boolean => {
  const v = (value || '').trim();
  if (!v) return true;
  // Common failure modes: full URL, encoded Firebase object path, query string included.
  if (/^https?:\/\//i.test(v)) return true;
  if (v.includes('?') || v.includes('&') || v.includes('token=')) return true;
  if (/%2f/i.test(v)) return true;
  return false;
};

export const deriveFileNameFromUrl = (url: string): string | null => {
  const raw = (url || '').trim();
  if (!raw) return null;

  try {
    const u = new URL(raw);

    // Firebase download URL form: /v0/b/<bucket>/o/<encodedObjectPath>
    const idx = u.pathname.indexOf('/o/');
    if (idx >= 0) {
      const encoded = u.pathname.slice(idx + 3); // after '/o/'
      const objectPath = decodeURIComponent(encoded);
      const parts = objectPath.split('/').filter(Boolean);
      const last = parts[parts.length - 1];
      return last ? last.trim() : null;
    }

    // GCS form: https://storage.googleapis.com/<bucket>/<path>
    const pathParts = u.pathname.split('/').filter(Boolean);
    const last = pathParts[pathParts.length - 1];
    return last ? decodeURIComponent(last).trim() : null;
  } catch {
    // Not a URL; try a last-segment heuristic.
    const noQuery = raw.split('?')[0];
    const parts = noQuery.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    return last ? decodeURIComponent(last).trim() : null;
  }
};

export const normalizeSharedFileName = (input: { fileUrl: string; fileName?: string | null }): string => {
  const provided = (input.fileName || '').trim();
  if (!looksLikeGarbageFileName(provided)) {
    return provided;
  }

  const derived = deriveFileNameFromUrl(input.fileUrl);
  if (derived) {
    // Trim obvious storage prefixes if present.
    return derived.replace(/^chat-files[_/\\]/i, '').trim() || derived;
  }

  return provided || 'file';
};

const DEFAULT_WEB_APP_BASE_URL = 'https://tuitionmanager.app';

const normalizeBaseUrl = (value?: string | null): string | null => {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
};

export const resolveWebAppBaseUrl = (): string => {
  const fromEnv = normalizeBaseUrl(process.env.EXPO_PUBLIC_WEB_APP_URL);
  if (fromEnv) return fromEnv;

  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    const origin = normalizeBaseUrl(window.location?.origin);
    if (origin) return origin;
  }

  return DEFAULT_WEB_APP_BASE_URL;
};

const normalizeHttpUrl = (value?: string | null): string | null => {
  const trimmed = (value || '').trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return null;
};

const resolvePublicApiBaseUrl = (): string | null => {
  const snap = runtimeEndpoints.getSnapshot();
  const fromSnap = normalizeHttpUrl(snap.apiBaseUrl || snap.notificationsApiBaseUrl || snap.wabaApiBaseUrl || snap.chatApiBaseUrl);
  if (fromSnap) return fromSnap;

  const fromEnv = normalizeHttpUrl(
    (process.env.EXPO_PUBLIC_PUBLIC_API_BASE_URL as string | undefined) ||
      (process.env.EXPO_PUBLIC_API_BASE_URL as string | undefined) ||
      undefined,
  );
  if (fromEnv) return fromEnv;

  return null;
};

const resolveAuthedApiBaseUrl = (): string | null => {
  const snap = runtimeEndpoints.getSnapshot();
  const fromSnap = normalizeHttpUrl(snap.apiBaseUrl || snap.notificationsApiBaseUrl || snap.wabaApiBaseUrl || snap.chatApiBaseUrl);
  if (fromSnap) return fromSnap;
  return resolvePublicApiBaseUrl();
};

const buildSmartLink = (fallbackUrl: string, deepLinkPath: string): string => {
  const base = resolveWebAppBaseUrl();
  const u = encodeURIComponent(fallbackUrl);
  const dl = encodeURIComponent(deepLinkPath.replace(/^\/+/, ''));
  return `${base}/l?u=${u}&dl=${dl}`;
};

const buildSmartShareLinkFromToken = (token: string): string => {
  const baseWeb = resolveWebAppBaseUrl();
  const safeToken = encodeURIComponent((token || '').trim());
  const webUrl = `${baseWeb}/shared/${safeToken}`;
  const deepLinkPath = `shared/${safeToken}`;
  return buildSmartLink(webUrl, deepLinkPath);
};

const hashString = (value: string): string => {
  // Small deterministic hash for AsyncStorage keys.
  let h = 5381;
  for (let i = 0; i < value.length; i++) {
    h = (h * 33) ^ value.charCodeAt(i);
  }
  return (h >>> 0).toString(16);
};

const cacheKeyForFile = (tenantId: string, fileUrl: string): string => {
  const tid = (tenantId || '').trim() || 'unknown';
  const url = (fileUrl || '').trim();
  return `shared_link_v1:${tid}:${hashString(url)}`;
};

type CachedSmartShareLink = {
  fileUrl: string;
  shareUrl: string;
  token?: string;
  createdAt?: string;
};

const inMemoryShareUrlByFile = new Map<string, string>();

const shareLinkCache = new Map<string, Promise<string>>();

const looksLikeAlreadySharedLink = (url: string): boolean => {
  const v = (url || '').trim();
  if (!v) return false;
  // Avoid wrapping our own smart links or shared routes.
  return /\/l\?/i.test(v) || /\/shared\//i.test(v) || /\/shared-files\//i.test(v);
};

const looksLikeFirebaseStorageUrl = (url: string): boolean => {
  const v = (url || '').toLowerCase();
  return v.includes('firebasestorage.googleapis.com') || v.includes('storage.googleapis.com');
};

export const sharedFileService = {
  buildSmartShareLinkFromToken,

  async getCachedSmartShareLink(input: { tenantId: string; fileUrl: string }): Promise<string | null> {
    const tenantId = (input.tenantId || '').trim();
    const fileUrl = (input.fileUrl || '').trim();
    if (!tenantId || !fileUrl) return null;

    const memKey = `${tenantId}::${fileUrl}`;
    const mem = inMemoryShareUrlByFile.get(memKey);
    if (mem) return mem;

    try {
      const raw = await AsyncStorage.getItem(cacheKeyForFile(tenantId, fileUrl));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedSmartShareLink;
      const shareUrl = typeof parsed?.shareUrl === 'string' ? parsed.shareUrl.trim() : '';
      const storedFileUrl = typeof parsed?.fileUrl === 'string' ? parsed.fileUrl.trim() : '';
      if (!shareUrl || !storedFileUrl || storedFileUrl !== fileUrl) return null;
      inMemoryShareUrlByFile.set(memKey, shareUrl);
      return shareUrl;
    } catch {
      return null;
    }
  },

  async cacheSmartShareLink(input: { tenantId: string; fileUrl: string; shareUrl: string; token?: string }): Promise<void> {
    const tenantId = (input.tenantId || '').trim();
    const fileUrl = (input.fileUrl || '').trim();
    const shareUrl = (input.shareUrl || '').trim();
    if (!tenantId || !fileUrl || !shareUrl) return;

    const memKey = `${tenantId}::${fileUrl}`;
    inMemoryShareUrlByFile.set(memKey, shareUrl);

    const payload: CachedSmartShareLink = {
      fileUrl,
      shareUrl,
      token: (input.token || '').trim() || undefined,
      createdAt: new Date().toISOString(),
    };

    try {
      await AsyncStorage.setItem(cacheKeyForFile(tenantId, fileUrl), JSON.stringify(payload));
    } catch {
      // ignore
    }
  },

  async recordUploadShareToken(input: { tenantId: string; fileUrl: string; shareToken: string }): Promise<string> {
    const shareUrl = buildSmartShareLinkFromToken(input.shareToken);
    await sharedFileService.cacheSmartShareLink({ tenantId: input.tenantId, fileUrl: input.fileUrl, shareUrl, token: input.shareToken });
    return shareUrl;
  },

  async createShareToken(input: {
    tenantId: string;
    fileUrl: string;
    fileName: string;
    fileType?: string;
    fileSize?: number;
    thumbnailUrl?: string;
  }): Promise<string> {
    const base = resolveAuthedApiBaseUrl();
    if (!base) {
      throw new Error('Backend URL not configured for sharing');
    }

    const token = await internalTokenManager.getToken(base);
    if (!token) {
      throw new Error('Not authenticated');
    }

    const res = await fetch(`${base}/shared-files/resolve-or-create`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tenantId: input.tenantId,
        fileUrl: input.fileUrl,
        fileName: input.fileName,
        fileType: input.fileType,
        fileSize: input.fileSize,
        thumbnailUrl: input.thumbnailUrl,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Share create failed (${res.status})`);
    }

    const data = (await res.json()) as { token?: string };
    const shareToken = typeof data?.token === 'string' ? data.token.trim() : '';
    if (!shareToken) {
      throw new Error('Share create failed (missing token)');
    }
    return shareToken;
  },

  async ensureSmartShareLink(input: {
    fileUrl: string;
    fileName: string;
    fileType?: string;
    fileSize?: number;
    thumbnailUrl?: string;
    tenantId?: string | null;
  }): Promise<string> {
    const rawUrl = (input.fileUrl || '').trim();
    if (!rawUrl) {
      throw new Error('Missing file URL');
    }

    // Only rewrite actual remote URLs (and avoid wrapping an existing share link).
    if (!/^https?:\/\//i.test(rawUrl)) {
      return rawUrl;
    }
    if (looksLikeAlreadySharedLink(rawUrl)) {
      return rawUrl;
    }

    // Pragmatic: only generate for Firebase Storage URLs by default.
    // If you later want this for any HTTPS URL, remove this check.
    if (!looksLikeFirebaseStorageUrl(rawUrl)) {
      return rawUrl;
    }

    const tenantIdForCache = (input.tenantId || (await tenantService.getCachedSelectedTenant()) || '').trim();
    if (tenantIdForCache) {
      const cached = await sharedFileService.getCachedSmartShareLink({ tenantId: tenantIdForCache, fileUrl: rawUrl });
      if (cached) return cached;
    }

    const cacheKey = `${rawUrl}::${(input.fileName || '').trim()}`;
    const cached = shareLinkCache.get(cacheKey);
    if (cached) {
      return await cached;
    }

    const work = (async () => {
      const tenantId = tenantIdForCache || (await tenantService.getCachedSelectedTenant()) || '';
      const normalizedTenantId = tenantId.trim();
      if (!normalizedTenantId) {
        throw new Error('Tenant not selected');
      }

      const effectiveFileName = normalizeSharedFileName({ fileUrl: rawUrl, fileName: input.fileName });

      const token = await sharedFileService.createShareToken({
        tenantId: normalizedTenantId,
        fileUrl: rawUrl,
        fileName: effectiveFileName,
        fileType: input.fileType,
        fileSize: input.fileSize,
        thumbnailUrl: input.thumbnailUrl,
      });

      const shareUrl = buildSmartShareLinkFromToken(token);
      await sharedFileService.cacheSmartShareLink({ tenantId: normalizedTenantId, fileUrl: rawUrl, shareUrl, token });
      return shareUrl;
    })().catch((err) => {
      // Drop failed entries so a retry can happen.
      shareLinkCache.delete(cacheKey);
      throw err;
    });

    shareLinkCache.set(cacheKey, work);
    return await work;
  },

  async fetchPublicSharedFile(token: string): Promise<SharedFileRecord> {
    const base = resolvePublicApiBaseUrl();
    if (!base) {
      throw new Error(
        'Backend URL not configured for public share links. Set EXPO_PUBLIC_PUBLIC_API_BASE_URL (or configure runtimeEndpoints cache).',
      );
    }

    const safeToken = encodeURIComponent((token || '').trim());
    const res = await fetch(`${base}/shared-files/public/${safeToken}`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Shared link not available (${res.status})`);
    }

    return (await res.json()) as SharedFileRecord;
  },

  async listMySharedFiles(options?: { tenantId?: string | null; limit?: number }): Promise<SharedFileRecord[]> {
    const base = resolveAuthedApiBaseUrl();
    if (!base) {
      throw new Error('Backend URL not configured');
    }

    const token = await internalTokenManager.getToken(base);
    if (!token) {
      throw new Error('Not authenticated');
    }

    const tenantId = (options?.tenantId || (await tenantService.getCachedSelectedTenant()) || '').trim();
    if (!tenantId) {
      throw new Error('Tenant not selected');
    }

    const limit = options?.limit ?? 50;
    const qs = new URLSearchParams({ tenantId, limit: String(limit) });
    const res = await fetch(`${base}/shared-files/mine?${qs.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(text || `Shared links list failed (${res.status})`);
    }

    const data = (await res.json()) as { items?: SharedFileRecord[] };
    return Array.isArray(data?.items) ? data.items : [];
  },
};

// Best-effort logging for missing env on web (helps diagnose public share link failures).
try {
  if (Platform.OS === 'web') {
    const base = resolvePublicApiBaseUrl();
    if (!base) {
      logger.debug?.('[sharedFileService] no public API base URL; set EXPO_PUBLIC_PUBLIC_API_BASE_URL');
    }
  }
} catch {
  // ignore
}
