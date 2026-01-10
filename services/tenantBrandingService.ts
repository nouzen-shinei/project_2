import { logger } from '@/lib/logger';
import { storage } from '@/config/firebase';
import { deleteObject, ref } from 'firebase/storage';
import { uploadBlobViaBackend } from './backendStorageUploadService';
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
    const result = await uploadBlobViaBackend({
      tenantId: normalizedTenantId,
      purpose: 'tenantLogo',
      blob,
      contentType: asset.mimeType || blob.type,
      filename,
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

export async function deleteTenantLogoByUrl(url?: string | null): Promise<void> {
  if (!url) {
    return;
  }
  try {
    const objectRef = ref(storage, url);
    await deleteObject(objectRef);
  } catch (error: any) {
    if (error?.code === 'storage/object-not-found') {
      return;
    }
    logger.warn('tenantBrandingService: failed to delete logo', error);
    throw new Error('Unable to remove the previous logo from storage.');
  }
}
