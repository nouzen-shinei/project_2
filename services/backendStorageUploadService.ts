import { logger } from '@/lib/logger';
import { internalTokenManager } from './internalTokenManager';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';
import { maybeShowStorageLimitReachedAlert } from './storageLimitAlert';
import { Platform } from 'react-native';
import { runtimeEndpoints } from './runtimeEndpoints';
import {
  UPLOAD_MAX_ATTEMPTS,
  isTransientUploadStatus,
  uploadRetryBackoffMs,
  uploadRetryDelay,
} from '@/lib/uploadRetry';

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

function buildUploadPreflightUrl(baseUrl: string, args: { tenantId: string; bytes: number }): string {
  const url = new URL(`${baseUrl}/storage/upload/preflight`);
  url.searchParams.set('tenantId', args.tenantId);
  url.searchParams.set('bytes', String(Math.max(0, Math.floor(args.bytes))));
  return url.toString();
}

function buildReconcileUrl(baseUrl: string, args: { tenantId: string }): string {
  const url = new URL(`${baseUrl}/storage/reconcile`);
  url.searchParams.set('tenantId', args.tenantId);
  return url.toString();
}

export type BackendStorageDeleteResponse = {
  ok: boolean;
  deleted?: boolean;
  alreadyDeleted?: boolean;
  path?: string;
  bytes?: number;
};

/**
 * Delete a tenant-owned storage object via the backend (Admin SDK). Client-side
 * `deleteObject` is disabled in storage.rules (M1); the backend verifies the
 * object lives under this tenant's managed prefix before deleting. `target` may
 * be a Firebase download URL, a gs:// URL, or a raw object path.
 */
export async function deleteStorageObjectViaBackend(args: {
  tenantId: string;
  target: string;
}): Promise<BackendStorageDeleteResponse> {
  const tenantId = (args.tenantId || '').trim();
  const target = (args.target || '').trim();
  if (!tenantId) {
    throw new Error('Tenant id is required to delete storage objects.');
  }
  if (!target) {
    return { ok: true, alreadyDeleted: true };
  }

  const baseUrl = resolveBackendBaseUrl();
  const url = new URL(`${baseUrl}/storage/delete`);
  url.searchParams.set('tenantId', tenantId);

  let headers = await buildAuthHeaders(baseUrl);
  headers['Content-Type'] = 'application/json';
  const body = JSON.stringify({ target });

  let response = await fetch(url.toString(), { method: 'POST', headers, body });

  if (response.status === 401) {
    await internalTokenManager.forceRefresh(baseUrl);
    headers = await buildAuthHeaders(baseUrl);
    headers['Content-Type'] = 'application/json';
    response = await fetch(url.toString(), { method: 'POST', headers, body });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    maybeShowMaintenanceAlertFromRaw(response.status, text);
    throw new Error(text || `storage_delete_failed_${response.status}`);
  }

  const text = await response.text();
  if (!text) {
    return { ok: true };
  }
  try {
    return JSON.parse(text) as BackendStorageDeleteResponse;
  } catch {
    return { ok: true };
  }
}

async function ensureUploadPreflight(args: {
  baseUrl: string;
  tenantId: string;
  bytes: number;
  suppressStorageLimitAlert?: boolean;
  context: string;
}): Promise<void> {
  const bytes = Number(args.bytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return;
  }

  const url = buildUploadPreflightUrl(args.baseUrl, {
    tenantId: args.tenantId,
    bytes,
  });

  let headers = await buildAuthHeaders(args.baseUrl);
  let response = await fetch(url, {
    method: 'GET',
    headers,
  });

  if (response.status === 401) {
    await internalTokenManager.forceRefresh(args.baseUrl);
    headers = await buildAuthHeaders(args.baseUrl);
    response = await fetch(url, {
      method: 'GET',
      headers,
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    maybeShowMaintenanceAlertFromRaw(response.status, text);
    if (!args.suppressStorageLimitAlert) {
      maybeShowStorageLimitReachedAlert(text, args.context, { incrementBytes: bytes });
    }
    throw new Error(text || `upload_preflight_failed_${response.status}`);
  }
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

// Transient blips (a dropped connection, a gateway hiccup) shouldn't fail an
// otherwise-fine upload — every non-chat upload (receipt, notice, student photo,
// tenant logo) flows through `uploadBlobViaBackend`, so the shared bounded retry
// (see lib/uploadRetry) makes all of them more reliable. Only genuinely transient
// failures are retried; deterministic errors (quota 409, too-large 413, auth,
// validation) fail fast as before, and the 401 token refresh is unchanged.

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
  suppressStorageLimitAlert?: boolean;
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

  const preflightBytes = Number((args.blob as any)?.size || 0);
  await ensureUploadPreflight({
    baseUrl,
    tenantId,
    bytes: preflightBytes,
    suppressStorageLimitAlert: args.suppressStorageLimitAlert,
    context: 'uploadBlobViaBackend(preflight)',
  });

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

        // Reject on a network-level failure so the retry loop can distinguish it
        // from an HTTP response (which resolves with a status).
        xhr.onerror = () => reject(new Error('upload_network_error'));
        xhr.onload = () => resolve({ status: xhr.status, responseText: xhr.responseText || '' });
        xhr.send(args.blob);
      });

    // One full attempt including the (one-shot) 401 token refresh.
    const runAttemptWithAuth = async (): Promise<{ status: number; responseText: string }> => {
      let authHeader = headers.Authorization;
      let result = await uploadOnce(authHeader);
      if (result.status === 401) {
        await internalTokenManager.forceRefresh(baseUrl);
        const refreshedHeaders = await buildAuthHeaders(baseUrl);
        authHeader = refreshedHeaders.Authorization;
        result = await uploadOnce(authHeader);
      }
      return result;
    };

    for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
      let result: { status: number; responseText: string };
      try {
        result = await runAttemptWithAuth();
      } catch (networkError) {
        // uploadOnce rejected -> network-level failure. Retry if attempts remain.
        if (attempt < UPLOAD_MAX_ATTEMPTS) {
          await uploadRetryDelay(uploadRetryBackoffMs(attempt));
          continue;
        }
        throw networkError;
      }

      // Retry transient gateway/availability statuses (but never on the last try).
      if (isTransientUploadStatus(result.status) && attempt < UPLOAD_MAX_ATTEMPTS) {
        await uploadRetryDelay(uploadRetryBackoffMs(attempt));
        continue;
      }

      if (result.status !== 200) {
        maybeShowMaintenanceAlertFromRaw(result.status, result.responseText);
        if (!args.suppressStorageLimitAlert) {
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
    // Unreachable: the final iteration always returns or throws.
    throw new Error('upload_failed');
  }

  // Native: one full attempt including the (one-shot) 401 token refresh.
  const runNativeAttemptWithAuth = async (): Promise<Response> => {
    let response = await fetch(url, { method: 'POST', headers, body: args.blob });
    if (response.status === 401) {
      await internalTokenManager.forceRefresh(baseUrl);
      headers = await buildAuthHeaders(baseUrl);
      headers['Content-Type'] = contentType;
      response = await fetch(url, { method: 'POST', headers, body: args.blob });
    }
    return response;
  };

  for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await runNativeAttemptWithAuth();
    } catch (networkError) {
      // fetch rejected -> network-level failure. Retry if attempts remain.
      if (attempt < UPLOAD_MAX_ATTEMPTS) {
        await uploadRetryDelay(uploadRetryBackoffMs(attempt));
        continue;
      }
      throw networkError;
    }

    if (isTransientUploadStatus(response.status) && attempt < UPLOAD_MAX_ATTEMPTS) {
      await uploadRetryDelay(uploadRetryBackoffMs(attempt));
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      maybeShowMaintenanceAlertFromRaw(response.status, text);
      if (!args.suppressStorageLimitAlert) {
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
  // Unreachable: the final iteration always returns or throws.
  throw new Error('upload_failed');
}
