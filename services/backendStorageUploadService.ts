import { logger } from '@/lib/logger';
import { internalTokenManager } from './internalTokenManager';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import { maybeShowStorageLimitReachedAlert } from './storageLimitAlert';
import { Platform } from 'react-native';
import { runtimeEndpoints } from './runtimeEndpoints';

export type StorageUploadPurpose =
  | 'chat'
  | 'tenantLogo'
  | 'noticeImage'
  | 'noticeAudio'
  | 'studentProfile'
  | 'receipt'
  | 'profilePicture';

export type BackendStorageUploadResponse = {
  url: string;
  path: string;
  bytes: number;
  contentType?: string;
};

export type BackendStorageReconcileResponse = {
  tenantId: string;
  bytes: number;
  limitBytes: number;
};

function resolveBackendBaseUrl(): string {
  const baseUrl = runtimeEndpoints.getPreferredBackendBaseUrl();
  if (!baseUrl) {
    throw new Error(
      'Backend upload URL not configured. Set Firestore appSettings/runtimeEndpoints.apiBaseUrl (or notificationsApiBaseUrl / wabaApiBaseUrl / chatApiBaseUrl).',
    );
  }

  internalTokenManager.setBaseUrl(baseUrl);
  return baseUrl;
}

async function buildAuthHeaders(baseUrl: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const token = await internalTokenManager.getToken(baseUrl);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function buildUploadUrl(
  baseUrl: string,
  args: {
    tenantId: string;
    purpose: StorageUploadPurpose;
    filename?: string;
    conversationFolder?: string;
    feeId?: string;
    email?: string;
  },
): string {
  const url = new URL(`${baseUrl}/storage/upload`);
  url.searchParams.set('tenantId', args.tenantId);
  url.searchParams.set('purpose', args.purpose);

  if (args.filename) url.searchParams.set('filename', args.filename);
  if (args.conversationFolder) url.searchParams.set('conversationFolder', args.conversationFolder);
  if (args.feeId) url.searchParams.set('feeId', args.feeId);
  if (args.email) url.searchParams.set('email', args.email);

  return url.toString();
}

function buildReconcileUrl(baseUrl: string, args: { tenantId: string }): string {
  const url = new URL(`${baseUrl}/storage/reconcile`);
  url.searchParams.set('tenantId', args.tenantId);
  return url.toString();
}

export async function reconcileTenantStorageUsageViaBackend(args: {
  tenantId: string;
}): Promise<BackendStorageReconcileResponse> {
  const tenantId = (args.tenantId || '').trim();
  if (!tenantId) {
    throw new Error('Tenant id is required.');
  }

  const baseUrl = resolveBackendBaseUrl();
  const url = buildReconcileUrl(baseUrl, { tenantId });

  let headers = await buildAuthHeaders(baseUrl);
  headers['Content-Type'] = 'application/json';

  let response = await fetch(url, {
    method: 'POST',
    headers,
  });

  if (response.status === 401) {
    await internalTokenManager.forceRefresh(baseUrl);
    headers = await buildAuthHeaders(baseUrl);
    headers['Content-Type'] = 'application/json';
    response = await fetch(url, {
      method: 'POST',
      headers,
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    maybeShowMaintenanceAlertFromRaw(response.status, text);
    throw new Error(text || `storage_reconcile_failed_${response.status}`);
  }

  const text = await response.text();
  if (!text) {
    throw new Error('storage_reconcile_failed_empty_response');
  }
  return JSON.parse(text) as BackendStorageReconcileResponse;
}

export async function uploadBlobViaBackend(args: {
  tenantId: string;
  purpose: StorageUploadPurpose;
  blob: Blob;
  contentType?: string | null;
  filename?: string;
  conversationFolder?: string;
  feeId?: string;
  email?: string;
  onProgress?: (progress: number) => void;
}): Promise<BackendStorageUploadResponse> {
  const tenantId = (args.tenantId || '').trim();
  if (!tenantId) {
    throw new Error('Tenant id is required for uploads.');
  }

  const baseUrl = resolveBackendBaseUrl();
  const url = buildUploadUrl(baseUrl, {
    tenantId,
    purpose: args.purpose,
    filename: args.filename,
    conversationFolder: args.conversationFolder,
    feeId: args.feeId,
    email: args.email,
  });

  const contentType = (args.contentType || (args.blob as any)?.type || 'application/octet-stream').toString();

  let headers = await buildAuthHeaders(baseUrl);
  headers['Content-Type'] = contentType;

  // Web: use XHR for true upload progress.
  if (Platform.OS === 'web' && typeof XMLHttpRequest !== 'undefined') {
    const uploadOnce = (authHeader?: string) =>
      new Promise<{ status: number; responseText: string }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', url);
        xhr.setRequestHeader('Content-Type', contentType);
        if (authHeader) {
          xhr.setRequestHeader('Authorization', authHeader);
        }

        if (typeof args.onProgress === 'function') {
          try {
            args.onProgress(0);
          } catch {}
          xhr.upload.onprogress = (evt) => {
            try {
              if (!evt.lengthComputable) return;
              const p = (evt.loaded / evt.total) * 100;
              args.onProgress?.(Math.max(0, Math.min(100, p)));
            } catch {
              // ignore
            }
          };
        }

        xhr.onerror = () => reject(new Error('upload_failed'));
        xhr.onload = () => resolve({ status: xhr.status, responseText: xhr.responseText || '' });
        xhr.send(args.blob);
      });

    let authHeader = headers.Authorization;
    let result = await uploadOnce(authHeader);

    if (result.status === 401) {
      await internalTokenManager.forceRefresh(baseUrl);
      const refreshedHeaders = await buildAuthHeaders(baseUrl);
      authHeader = refreshedHeaders.Authorization;
      result = await uploadOnce(authHeader);
    }

    if (result.status !== 200) {
      maybeShowMaintenanceAlertFromRaw(result.status, result.responseText);
      if (result.status === 409) {
        maybeShowStorageLimitReachedAlert(result.responseText, 'uploadBlobViaBackend');
      }
      throw new Error(result.responseText || `upload_failed_${result.status}`);
    }

    const text = result.responseText;
    if (!text) {
      throw new Error('upload_failed_empty_response');
    }

    try {
      if (typeof args.onProgress === 'function') {
        try {
          args.onProgress(100);
        } catch {}
      }
      return JSON.parse(text) as BackendStorageUploadResponse;
    } catch (error) {
      logger.warn('[backendStorageUploadService] Failed to parse upload response JSON', { url, error });
      throw error;
    }
  }

  let response = await fetch(url, {
    method: 'POST',
    headers,
    body: args.blob,
  });

  if (response.status === 401) {
    await internalTokenManager.forceRefresh(baseUrl);
    headers = await buildAuthHeaders(baseUrl);
    headers['Content-Type'] = contentType;
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: args.blob,
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    maybeShowMaintenanceAlertFromRaw(response.status, text);
    if (response.status === 409) {
      maybeShowStorageLimitReachedAlert(text, 'uploadBlobViaBackend');
    }
    throw new Error(text || `upload_failed_${response.status}`);
  }

  const text = await response.text();
  if (!text) {
    throw new Error('upload_failed_empty_response');
  }

  try {
    return JSON.parse(text) as BackendStorageUploadResponse;
  } catch (error) {
    logger.warn('[backendStorageUploadService] Failed to parse upload response JSON', { url, error });
    throw error;
  }
}
