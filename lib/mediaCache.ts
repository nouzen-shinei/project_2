import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Crypto from 'expo-crypto';

// Minimal cross-platform media cache helper
// - Native (iOS/Android): stores files in FileSystem.cacheDirectory/media-cache
// - Web: uses Cache Storage API when available; falls back to browser HTTP cache

export type MediaCacheOptions = {
  fileName?: string;
  ttlMs?: number; // time-to-live; if expired, re-download. Default: 30 days
  cacheKey?: string; // optional custom key to identify content regardless of URL
};

export type CachedMediaResult = {
  uri: string; // local file:// URI (native) or object URL (web)
  revoke?: () => void; // call on web to release object URL
  fromCache: boolean;
};

const DEFAULT_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days

function getExtensionFromName(name?: string): string | undefined {
  if (!name) return undefined;
  const q = name.split('?')[0];
  const dot = q.lastIndexOf('.')
  if (dot > -1 && dot < q.length - 1) {
    const ext = q.slice(dot + 1).toLowerCase();
    if (ext.length <= 6) return `.${ext}`;
  }
  return undefined;
}

async function ensureDir(dirUri: string) {
  try {
    const info = await FileSystem.getInfoAsync(dirUri);
    if (!info.exists) {
      await FileSystem.makeDirectoryAsync(dirUri, { intermediates: true });
    }
  } catch {
    // ignore
  }
}

export async function getCachedMediaUri(remoteUri: string, options: MediaCacheOptions = {}): Promise<CachedMediaResult> {
  const ttl = options.ttlMs ?? DEFAULT_TTL;
  const now = Date.now();

  if (Platform.OS === 'web') {
    // Prefer Cache Storage API if available
    const g: any = globalThis as any;
    const cacheName = 'media-cache-v1';
    const cachesApi = g.caches;
    try {
      if (cachesApi && typeof cachesApi.open === 'function') {
        const cache = await cachesApi.open(cacheName);
        let res = await cache.match(remoteUri);
        if (!res || (ttl && res.headers.has('date'))) {
          // If no response or expired check is needed, attempt fetch & put
          try {
            const fetched = await fetch(remoteUri, { cache: 'force-cache' as RequestCache });
            if (fetched && fetched.ok) {
              await cache.put(remoteUri, fetched.clone());
              res = fetched;
            }
          } catch {
            // ignore fetch failure, try existing
          }
        }
        if (!res) {
          // Fallback to direct fetch
          const fetched = await fetch(remoteUri);
          res = fetched;
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        return { uri: objectUrl, revoke: () => URL.revokeObjectURL(objectUrl), fromCache: true };
      }
    } catch {
      // ignore and fall through
    }
    // Fallback: rely on browser cache by returning the remote URL directly
    return { uri: remoteUri, fromCache: false };
  }

  // Native path
  const baseDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
  const mediaDir = baseDir + 'media-cache/';
  await ensureDir(mediaDir);

  const keySource = options.cacheKey ? `${options.cacheKey}:${remoteUri}` : remoteUri;
  const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA1, keySource);
  const ext = getExtensionFromName(options.fileName || remoteUri) || '.bin';
  const localPath = `${mediaDir}${hash}${ext}`;

  // If file exists and not expired, return it
  try {
    const info = await FileSystem.getInfoAsync(localPath, { size: true });
    if (info.exists) {
      // Check TTL using modification time when available
      const mtime = (info as any).modificationTime ? ((info as any).modificationTime as number) * 1000 : now;
      if (!ttl || now - mtime < ttl) {
        return { uri: localPath, fromCache: true };
      }
    }
  } catch {
    // proceed to download
  }

  // Download and save
  try {
    const tmpPath = `${localPath}.tmp`;
    try { await FileSystem.deleteAsync(tmpPath, { idempotent: true }); } catch {}
    const result = await FileSystem.downloadAsync(remoteUri, tmpPath);
    if (result && result.status >= 200 && result.status < 400) {
      // Move to final path (overwrite if exists)
      try { await FileSystem.deleteAsync(localPath, { idempotent: true }); } catch {}
      await FileSystem.moveAsync({ from: tmpPath, to: localPath });
      return { uri: localPath, fromCache: false };
    }
  } catch {
    // ignore
  }

  // As a last resort, return remote URL
  return { uri: remoteUri, fromCache: false };
}

export async function clearMediaCache(): Promise<void> {
  if (Platform.OS === 'web') {
    const g: any = globalThis as any;
    try {
      if (g.caches && typeof g.caches.delete === 'function') {
        await g.caches.delete('media-cache-v1');
      }
    } catch {}
    return;
  }
  const baseDir = FileSystem.cacheDirectory ?? FileSystem.documentDirectory ?? FileSystem.cacheDirectory;
  const mediaDir = (baseDir || '') + 'media-cache/';
  try {
    await FileSystem.deleteAsync(mediaDir, { idempotent: true });
  } catch {}
}
