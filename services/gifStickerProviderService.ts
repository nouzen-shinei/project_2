import { logger } from '@/lib/logger';

/**
 * Unified GIF/Sticker provider service.
 *
 * Replaces the discontinued Tenor integration (shut down by Google — see
 * https://developers.google.com/tenor) with two env-driven providers:
 *
 *  - Giphy  (https://developers.giphy.com) — preferred by default.
 *  - Klipy  (https://docs.klipy.com)        — automatic fallback / secondary.
 *
 * Both providers are optional and independently toggleable via env vars.
 * Whichever provider is configured and healthy is used; if the preferred
 * provider is unavailable (missing key, disabled, or recently failing) the
 * other one is used automatically, both for the *initial* choice and via
 * in-request failover if a call to the preferred provider throws.
 *
 * Env vars:
 *   EXPO_PUBLIC_GIPHY_API_KEY     – Giphy API key (required to enable Giphy)
 *   EXPO_PUBLIC_GIPHY_ENABLED     – '0'/'false' to force-disable Giphy even if a key is set (default: enabled)
 *   EXPO_PUBLIC_KLIPY_API_KEY     – Klipy API key (required to enable Klipy)
 *   EXPO_PUBLIC_KLIPY_ENABLED     – '0'/'false' to force-disable Klipy even if a key is set (default: enabled)
 */

export type GifStickerSource = 'giphy' | 'klipy';

export interface GifStickerMedia {
  id: string;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  title: string;
  source: GifStickerSource;
}

export interface GifStickerCategory {
  id: string;
  name: string;
  /** Empty string means "trending" (no search query). */
  searchTerm: string;
  preview: string;
}

export interface GifStickerPage {
  items: GifStickerMedia[];
  hasMore: boolean;
  nextPage: number;
  source: GifStickerSource | null;
}

type MediaKind = 'gifs' | 'stickers';

const GIPHY_API_KEY = (process.env.EXPO_PUBLIC_GIPHY_API_KEY || '').trim();
const KLIPY_API_KEY = (process.env.EXPO_PUBLIC_KLIPY_API_KEY || '').trim();

function isFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue;
  return value === '1' || value.toLowerCase() === 'true';
}

// A provider is enabled only when its API key is present AND it hasn't been
// explicitly disabled. This lets either provider be toggled independently in
// each environment (.env / EAS build profile) without code changes.
const GIPHY_ENABLED = Boolean(GIPHY_API_KEY) && isFlagEnabled(process.env.EXPO_PUBLIC_GIPHY_ENABLED, true);
const KLIPY_ENABLED = Boolean(KLIPY_API_KEY) && isFlagEnabled(process.env.EXPO_PUBLIC_KLIPY_ENABLED, true);

const GIPHY_BASE_URL = 'https://api.giphy.com/v1';
const KLIPY_BASE_URL = 'https://api.klipy.com/api/v1';
const REQUEST_TIMEOUT_MS = 8000;
const CIRCUIT_BREAKER_COOLDOWN_MS = 2 * 60 * 1000; // 2 minutes
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 2;

// ---------------------------------------------------------------------------
// Per-provider circuit breaker.
//
// When a provider fails repeatedly (outage, revoked key, etc.) it is marked
// "down" for a cooldown window so subsequent requests skip straight to the
// other provider instead of waiting on a doomed call every time. This is the
// "auto switch when down" behavior — combined with the in-request failover
// below, it gives both fast recovery within a single request and reduced
// latency across the outage window.
// ---------------------------------------------------------------------------
interface CircuitState {
  consecutiveFailures: number;
  downUntil: number; // epoch ms; 0 when healthy
}

const circuitState: Record<GifStickerSource, CircuitState> = {
  giphy: { consecutiveFailures: 0, downUntil: 0 },
  klipy: { consecutiveFailures: 0, downUntil: 0 },
};

function isProviderEnabled(source: GifStickerSource): boolean {
  return source === 'giphy' ? GIPHY_ENABLED : KLIPY_ENABLED;
}

function isProviderHealthy(source: GifStickerSource): boolean {
  return Date.now() >= circuitState[source].downUntil;
}

function recordSuccess(source: GifStickerSource): void {
  circuitState[source].consecutiveFailures = 0;
  circuitState[source].downUntil = 0;
}

function recordFailure(source: GifStickerSource): void {
  const state = circuitState[source];
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    state.downUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    logger.warn(
      `[gifStickerProvider] ${source} marked as down for ${Math.round(CIRCUIT_BREAKER_COOLDOWN_MS / 1000)}s after ${state.consecutiveFailures} consecutive failures`
    );
  }
}

/**
 * Resolve the provider call order for a request. Giphy is preferred whenever
 * it's enabled and healthy; Klipy is used first when Giphy is disabled or
 * currently in its failure cooldown. Both are included (healthy-first) so a
 * mid-request failure of the preferred provider automatically falls through
 * to the other one.
 */
function resolveProviderOrder(): GifStickerSource[] {
  const candidates: GifStickerSource[] = (['giphy', 'klipy'] as const).filter(isProviderEnabled);
  return candidates.sort((a, b) => {
    const aHealthy = isProviderHealthy(a) ? 0 : 1;
    const bHealthy = isProviderHealthy(b) ? 0 : 1;
    if (aHealthy !== bHealthy) return aHealthy - bHealthy;
    // Stable preference: giphy before klipy when health is equal.
    return a === 'giphy' ? -1 : 1;
  });
}

async function fetchWithTimeout(url: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Giphy adapter — https://developers.giphy.com/docs/api/endpoint
// ---------------------------------------------------------------------------

interface GiphyImageVariant {
  url: string;
  width: string;
  height: string;
}

interface GiphyResult {
  id: string;
  title: string;
  images: {
    original?: GiphyImageVariant;
    fixed_width?: GiphyImageVariant;
    fixed_width_small?: GiphyImageVariant;
    fixed_height?: GiphyImageVariant;
    fixed_height_small?: GiphyImageVariant;
    preview_gif?: GiphyImageVariant;
  };
}

interface GiphyResponse {
  data: GiphyResult[];
  pagination?: { total_count: number; count: number; offset: number };
}

function convertGiphyResult(result: GiphyResult): GifStickerMedia {
  const images = result.images || {};
  const full = images.fixed_width || images.original || images.fixed_height;
  const thumb = images.fixed_width_small || images.preview_gif || images.fixed_height_small || full;

  return {
    id: result.id,
    url: full?.url || '',
    thumbnailUrl: thumb?.url || full?.url || '',
    width: Number(full?.width) || 200,
    height: Number(full?.height) || 200,
    title: result.title || 'GIF',
    source: 'giphy',
  };
}

async function giphyFetchPage(params: {
  kind: MediaKind;
  query?: string;
  page: number;
  perPage: number;
}): Promise<GifStickerPage> {
  const { kind, query, page, perPage } = params;
  const endpoint = kind === 'stickers' ? 'stickers' : 'gifs';
  const offset = page * perPage;

  const url = query
    ? `${GIPHY_BASE_URL}/${endpoint}/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=${perPage}&offset=${offset}&rating=pg-13`
    : `${GIPHY_BASE_URL}/${endpoint}/trending?api_key=${GIPHY_API_KEY}&limit=${perPage}&offset=${offset}&rating=pg-13`;

  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Giphy HTTP ${response.status}`);
  }

  const data: GiphyResponse = await response.json();
  const items = (data.data || []).map(convertGiphyResult).filter((item) => item.url);
  const totalCount = data.pagination?.total_count ?? offset + items.length;
  const hasMore = offset + items.length < totalCount && items.length > 0;

  return { items, hasMore, nextPage: page + 1, source: 'giphy' };
}

// ---------------------------------------------------------------------------
// Klipy adapter — https://docs.klipy.com/gifs-api / stickers-api
// ---------------------------------------------------------------------------

interface KlipyFileVariant {
  url: string;
  width: number;
  height: number;
}

interface KlipyResult {
  id: number | string;
  slug: string;
  title: string;
  file: {
    md?: { gif?: KlipyFileVariant; webp?: KlipyFileVariant };
    sm?: { gif?: KlipyFileVariant; webp?: KlipyFileVariant };
    xs?: { gif?: KlipyFileVariant; webp?: KlipyFileVariant; jpg?: KlipyFileVariant };
  };
}

interface KlipyResponse {
  result: boolean;
  data?: {
    data: KlipyResult[];
    current_page: number;
    per_page: number;
    has_next: boolean;
  };
}

function convertKlipyResult(result: KlipyResult): GifStickerMedia {
  const full = result.file?.md?.gif || result.file?.sm?.gif || result.file?.md?.webp;
  const thumb = result.file?.xs?.gif || result.file?.xs?.webp || result.file?.xs?.jpg || full;

  return {
    id: String(result.id ?? result.slug),
    url: full?.url || '',
    thumbnailUrl: thumb?.url || full?.url || '',
    width: full?.width || 200,
    height: full?.height || 200,
    title: result.title || 'GIF',
    source: 'klipy',
  };
}

async function klipyFetchPage(params: {
  kind: MediaKind;
  query?: string;
  page: number;
  perPage: number;
}): Promise<GifStickerPage> {
  const { kind, query, page, perPage } = params;
  const endpoint = kind === 'stickers' ? 'stickers' : 'gifs';
  const requestedPage = page + 1; // Klipy pagination is 1-indexed

  const url = query
    ? `${KLIPY_BASE_URL}/${KLIPY_API_KEY}/${endpoint}/search?q=${encodeURIComponent(query)}&page=${requestedPage}&per_page=${perPage}`
    : `${KLIPY_BASE_URL}/${KLIPY_API_KEY}/${endpoint}/trending?page=${requestedPage}&per_page=${perPage}`;

  const response = await fetchWithTimeout(url);
  if (!response.ok) {
    throw new Error(`Klipy HTTP ${response.status}`);
  }

  const payload: KlipyResponse = await response.json();
  if (!payload.result || !payload.data) {
    throw new Error('Klipy response missing data');
  }

  const items = payload.data.data.map(convertKlipyResult).filter((item) => item.url);
  return { items, hasMore: Boolean(payload.data.has_next), nextPage: page + 1, source: 'klipy' };
}

// ---------------------------------------------------------------------------
// Unified entry points with automatic provider failover
// ---------------------------------------------------------------------------

const PROVIDER_FETCHERS: Record<GifStickerSource, typeof giphyFetchPage> = {
  giphy: giphyFetchPage,
  klipy: klipyFetchPage,
};

async function fetchPageWithFailover(params: {
  kind: MediaKind;
  query?: string;
  page: number;
  perPage: number;
}): Promise<GifStickerPage> {
  const providerOrder = resolveProviderOrder();

  if (providerOrder.length === 0) {
    logger.warn('[gifStickerProvider] No GIF/sticker provider configured (set EXPO_PUBLIC_GIPHY_API_KEY and/or EXPO_PUBLIC_KLIPY_API_KEY)');
    return { items: [], hasMore: false, nextPage: params.page, source: null };
  }

  let lastError: unknown = null;
  for (const source of providerOrder) {
    try {
      const page = await PROVIDER_FETCHERS[source](params);
      recordSuccess(source);
      return page;
    } catch (error) {
      lastError = error;
      recordFailure(source);
      logger.warn(`[gifStickerProvider] ${source} request failed${providerOrder.length > 1 ? ', trying next provider' : ''}`, error);
    }
  }

  logger.error('[gifStickerProvider] All configured providers failed', lastError);
  return { items: [], hasMore: false, nextPage: params.page, source: null };
}

/** Whether at least one GIF/sticker provider is configured and enabled. */
export function isGifStickerProviderConfigured(): boolean {
  return GIPHY_ENABLED || KLIPY_ENABLED;
}

export async function fetchGifs(query: string | undefined, page: number, perPage = 20): Promise<GifStickerPage> {
  return fetchPageWithFailover({ kind: 'gifs', query, page, perPage });
}

export async function fetchStickers(query: string | undefined, page: number, perPage = 20): Promise<GifStickerPage> {
  return fetchPageWithFailover({ kind: 'stickers', query, page, perPage });
}

// Category browsing is provider-agnostic: each category maps to a search
// term (or '' for trending) that is forwarded to whichever provider serves
// the request.
export const STICKER_CATEGORIES: GifStickerCategory[] = [
  { id: 'trending', name: 'Trending', searchTerm: '', preview: '🔥' },
  { id: 'reactions', name: 'Reactions', searchTerm: 'reactions', preview: '😂' },
  { id: 'love', name: 'Love', searchTerm: 'love heart', preview: '❤️' },
  { id: 'animals', name: 'Animals', searchTerm: 'cute animals', preview: '🐱' },
  { id: 'celebrations', name: 'Party', searchTerm: 'party celebration', preview: '🎉' },
  { id: 'activities', name: 'Activities', searchTerm: 'sports activities', preview: '⚽' },
  { id: 'thumbs', name: 'Thumbs', searchTerm: 'thumbs up', preview: '👍' },
  { id: 'greeting', name: 'Greetings', searchTerm: 'hello wave', preview: '👋' },
];
