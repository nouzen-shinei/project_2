import { logger } from '@/lib/logger';

const CACHE_NAME = 'chat-media-cache-v1';
const INDEX_KEY = 'chat-media-cache-index-v1';
const CLEANUP_INTERVAL_MS = 30_000;

interface CacheIndexEntry {
  cachedAt: number;
}

interface MemoryEntry {
  objectUrl: string;
  cachedAt: number;
}

const globalScope: any = typeof globalThis !== 'undefined' ? globalThis : {};
const cacheStorage: any = globalScope?.caches ?? null;
const localStorageRef: any = (() => {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch (error) {
    logger.debug?.('webMediaCache: localStorage unavailable', error);
  }
  return null;
})();

class WebMediaCache {
  private memory = new Map<string, MemoryEntry>();
  private index: Record<string, CacheIndexEntry> | null = null;
  private cachePromise: Promise<any> | null = null;
  private pending = new Map<string, Promise<string>>();
  private lastCleanup = 0;
  private readonly supported: boolean;
  private readonly allowObjectUrls: boolean;

  constructor() {
    this.supported = typeof window !== 'undefined' && !!cacheStorage && typeof fetch === 'function';
    this.allowObjectUrls = this.detectObjectUrlSupport();
  }

  isSupported(): boolean {
    return this.supported;
  }

  private detectObjectUrlSupport(): boolean {
    if (typeof document === 'undefined') {
      return true;
    }

    const cspMetas = Array.from(document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'));
    if (!cspMetas.length) {
      return false;
    }

    for (const meta of cspMetas) {
      const content = meta.getAttribute('content') || '';
      const directives = content.split(';').map((directive) => directive.trim());
      for (const directive of directives) {
        const parts = directive.split(/\s+/).filter(Boolean);
        if (!parts.length) {
          continue;
        }

        const directiveName = parts[0].toLowerCase().replace(/:$/, '');
        if (directiveName !== 'img-src') {
          continue;
        }

        const tokens = parts
          .slice(1)
          .map((token) => token.replace(/^'+|'+$/g, '').toLowerCase());

        if (tokens.includes('blob:') || tokens.includes('*')) {
          return true;
        }
        return false;
      }
    }

    return false;
  }

  private async getCache(): Promise<any | null> {
    if (!this.supported) return null;
    if (!this.cachePromise) {
      this.cachePromise = cacheStorage
        .open(CACHE_NAME)
        .catch((error: any) => {
          logger.debug?.('webMediaCache: failed to open CacheStorage', error);
          return null;
        });
    }
    return this.cachePromise;
  }

  private async getIndex(): Promise<Record<string, CacheIndexEntry>> {
    if (this.index) {
      return this.index;
    }
    if (!localStorageRef) {
      this.index = {};
      return this.index;
    }
    try {
      const raw = localStorageRef.getItem(INDEX_KEY);
      this.index = raw ? (JSON.parse(raw) as Record<string, CacheIndexEntry>) : {};
    } catch (error) {
      logger.debug?.('webMediaCache: failed to read cache index', error);
      this.index = {};
    }
    return this.index;
  }

  private async saveIndex(): Promise<void> {
    if (!localStorageRef || !this.index) return;
    try {
      localStorageRef.setItem(INDEX_KEY, JSON.stringify(this.index));
    } catch (error) {
      logger.debug?.('webMediaCache: failed to persist cache index', error);
    }
  }

  private remember(remoteUrl: string, objectUrl: string): void {
    if (!this.allowObjectUrls) {
      return;
    }
    const existing = this.memory.get(remoteUrl);
    if (existing?.objectUrl && existing.objectUrl !== objectUrl) {
      URL.revokeObjectURL(existing.objectUrl);
    }
    this.memory.set(remoteUrl, { objectUrl, cachedAt: Date.now() });
  }

  private async remove(remoteUrl: string): Promise<void> {
    const cache = await this.getCache();
    if (cache) {
      try {
        await cache.delete(remoteUrl);
      } catch (error) {
        logger.debug?.('webMediaCache: failed to delete cache entry', { remoteUrl, error });
      }
    }
    const entry = this.memory.get(remoteUrl);
    if (entry) {
      if (this.allowObjectUrls) {
        URL.revokeObjectURL(entry.objectUrl);
      }
      this.memory.delete(remoteUrl);
    }
    const index = await this.getIndex();
    if (index[remoteUrl]) {
      delete index[remoteUrl];
      await this.saveIndex();
    }
  }

  private isExpired(entry: CacheIndexEntry, ttlMs: number): boolean {
    return Date.now() - entry.cachedAt > ttlMs;
  }

  async getCached(remoteUrl: string, ttlMs: number): Promise<string | null> {
    if (!this.supported || !remoteUrl || remoteUrl.startsWith('data:') || remoteUrl.startsWith('blob:')) {
      return null;
    }

    if (this.allowObjectUrls) {
      const memoryEntry = this.memory.get(remoteUrl);
      if (memoryEntry) {
        if (!this.isExpired({ cachedAt: memoryEntry.cachedAt }, ttlMs)) {
          return memoryEntry.objectUrl;
        }
        URL.revokeObjectURL(memoryEntry.objectUrl);
        this.memory.delete(remoteUrl);
      }
    }

    const index = await this.getIndex();
    const meta = index[remoteUrl];
    if (!meta) {
      return null;
    }

    if (this.isExpired(meta, ttlMs)) {
      await this.remove(remoteUrl);
      return null;
    }

    const cache = await this.getCache();
    if (!cache) return null;

    try {
      const response = await cache.match(remoteUrl);
      if (!response) {
        await this.remove(remoteUrl);
        return null;
      }

      if (!this.allowObjectUrls) {
        return remoteUrl;
      }

      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      this.remember(remoteUrl, objectUrl);
      return objectUrl;
    } catch (error) {
      logger.debug?.('webMediaCache: failed to read cached response', { remoteUrl, error });
      await this.remove(remoteUrl);
      return null;
    }
  }

  async fetchAndCache(remoteUrl: string, ttlMs: number): Promise<string> {
    if (!this.supported || !remoteUrl || remoteUrl.startsWith('data:') || remoteUrl.startsWith('blob:')) {
      return remoteUrl;
    }

    const cached = await this.getCached(remoteUrl, ttlMs);
    if (cached) {
      return cached;
    }

    if (this.pending.has(remoteUrl)) {
      return this.pending.get(remoteUrl)!;
    }

    const downloadPromise = (async () => {
      try {
        // Firebase Storage returns wildcard CORS headers, so credentials must stay omitted.
        const response = await fetch(remoteUrl, { credentials: 'omit', mode: 'cors' });
        if (!response.ok) {
          throw new Error(`Failed to fetch media (${response.status})`);
        }

        const cache = await this.getCache();
        if (cache) {
          try {
            await cache.put(remoteUrl, response.clone());
          } catch (error) {
            logger.debug?.('webMediaCache: cache.put failed', { remoteUrl, error });
          }
        }

        if (this.allowObjectUrls) {
          const blob = await response.blob();
          const objectUrl = URL.createObjectURL(blob);
          this.remember(remoteUrl, objectUrl);
          const index = await this.getIndex();
          index[remoteUrl] = { cachedAt: Date.now() };
          await this.saveIndex();

          await this.cleanup(ttlMs);
          return objectUrl;
        }

        const index = await this.getIndex();
        index[remoteUrl] = { cachedAt: Date.now() };
        await this.saveIndex();

        await this.cleanup(ttlMs);
        return remoteUrl;
      } finally {
        this.pending.delete(remoteUrl);
      }
    })();

    this.pending.set(remoteUrl, downloadPromise);
    return downloadPromise;
  }

  async warm(remoteUrl: string, ttlMs: number): Promise<void> {
    if (!this.supported) return;
    try {
      await this.fetchAndCache(remoteUrl, ttlMs);
    } catch (error) {
      logger.debug?.('webMediaCache: warm cache failed', { remoteUrl, error });
    }
  }

  async cleanup(ttlMs: number): Promise<void> {
    if (!this.supported) return;
    const now = Date.now();
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastCleanup = now;

    const index = await this.getIndex();
    const cache = await this.getCache();
    let dirty = false;

    await Promise.all(
      Object.entries(index).map(async ([remoteUrl, entry]) => {
        if (this.isExpired(entry, ttlMs)) {
          dirty = true;
          if (cache) {
            try {
              await cache.delete(remoteUrl);
            } catch (error) {
              logger.debug?.('webMediaCache: cleanup delete failed', { remoteUrl, error });
            }
          }
          const memoryEntry = this.memory.get(remoteUrl);
          if (memoryEntry) {
            if (this.allowObjectUrls) {
              URL.revokeObjectURL(memoryEntry.objectUrl);
            }
            this.memory.delete(remoteUrl);
          }
          delete index[remoteUrl];
        }
      })
    );

    if (dirty) {
      await this.saveIndex();
    }
  }
}

export const webMediaCache = new WebMediaCache();
