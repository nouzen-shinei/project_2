import { logger } from '@/lib/logger';
import { uploadBlobViaBackend, deleteStorageObjectViaBackend } from './backendStorageUploadService';
import { newUploadKey } from '@/lib/uploadKey';
import { tryExtractStorageLimitReachedInfo } from './storageLimitAlert';

export interface TenantLogoAsset {
  uri: string;
  mimeType?: string | null;
  fileName?: string;
}

export const TENANT_LOGO_MAX_BYTES = 4 * 1024 * 1024; // 4 MB limit keeps uploads lightweight

export type TenantLogoUploadResult = {
  url: string | null;
  skippedBecauseStorageLimit: boolean;
  failed: boolean;
};

const MIME_EXTENSION_MAP: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
};

function inferExtension(asset: TenantLogoAsset): string {
  if (asset.mimeType && MIME_EXTENSION_MAP[asset.mimeType]) {
    return MIME_EXTENSION_MAP[asset.mimeType];
  }
  if (asset.fileName) {
    const match = asset.fileName.split('.').pop();
    if (match) {
      return match.toLowerCase();
    }
  }
  return 'jpg';
}

export async function uploadTenantLogo(tenantId: string, asset: TenantLogoAsset): Promise<TenantLogoUploadResult> {
  const normalizedTenantId = tenantId?.trim();
  if (!normalizedTenantId) {
    throw new Error('Missing tenant id for logo upload');
  }
  if (!asset?.uri) {
    throw new Error('Missing asset for logo upload');
  }

  const response = await fetch(asset.uri);
  const blob = await response.blob();

  if (blob.size > TENANT_LOGO_MAX_BYTES) {
    throw new Error('Logo exceeds the 4 MB upload limit. Please pick a smaller image.');
  }

  try {
    const extension = inferExtension(asset);
    const filename = asset.fileName || `logo.${extension}`;
    // Idempotency key for this one logo upload (upload-idempotency spec, Req
    // 7.1/7.3). `uploadTenantLogo` is invoked once per settings save / tenant
    // create with a pending asset and has no retry loop of its own, so one call
    // is one logical upload action; `uploadBlobViaBackend` reuses this key for
    // every transient retry it makes. Picking a new logo later mints a fresh key
    // so it lands as a new object (the previous one is removed explicitly via
    // `deleteTenantLogoByUrl`) instead of silently replacing the old bytes.
    const uploadKey = newUploadKey('tenant_logo');
    const result = await uploadBlobViaBackend({
      tenantId: normalizedTenantId,
      purpose: 'tenantLogo',
      blob,
      contentType: asset.mimeType || blob.type,
      filename,
      uploadKey,
      suppressStorageLimitAlert: true,
    });
    return { url: result.url, skippedBecauseStorageLimit: false, failed: false };
  } catch (error) {
    const isStorageLimit = !!tryExtractStorageLimitReachedInfo(error);
    logger.error('tenantBrandingService: logo upload failed', { error, isStorageLimit });
    if (isStorageLimit) {
      return { url: null, skippedBecauseStorageLimit: true, failed: false };
    }
    return { url: null, skippedBecauseStorageLimit: false, failed: true };
  }
}

export async function deleteTenantLogoByUrl(tenantId: string, url?: string | null): Promise<void> {
  if (!url) {
    return;
  }
  try {
    // Server-mediated delete (security-rules-hardening M1): client deleteObject is
    // disabled in storage.rules; the backend verifies the object is under this
    // tenant's `tenant-branding/{tenantId}/…` prefix before deleting.
    await deleteStorageObjectViaBackend({ tenantId, target: url });
  } catch (error: any) {
    logger.warn('tenantBrandingService: failed to delete logo', error);
    throw new Error('Unable to remove the previous logo from storage.');
  }
}
