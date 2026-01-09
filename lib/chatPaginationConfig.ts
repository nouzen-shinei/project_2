export type ChatPaginationPlatform = 'native' | 'web';

export interface ChatPaginationProfile {
  platform: ChatPaginationPlatform;
  pageSize: number;
  bootstrapPages: number;
  bootstrapWindowSize: number;
  cacheLimit: number;
  prefetchThreshold: number;
  prefetchPageSize: number;
  realtimeReconcileSize: number;
}

type NumericSettingKey = 'pageSize' | 'bootstrapPages' | 'cacheLimit' | 'prefetchThreshold';

const BASE_ENV_KEYS: Record<NumericSettingKey, string> = {
  pageSize: 'EXPO_PUBLIC_CHAT_PAGE_SIZE',
  bootstrapPages: 'EXPO_PUBLIC_CHAT_BOOTSTRAP_PAGES',
  cacheLimit: 'EXPO_PUBLIC_CHAT_CACHE_LIMIT',
  prefetchThreshold: 'EXPO_PUBLIC_CHAT_PREFETCH_THRESHOLD',
};

const PLATFORM_ENV_KEYS: Record<ChatPaginationPlatform, Record<NumericSettingKey, string>> = {
  native: {
    pageSize: 'EXPO_PUBLIC_CHAT_PAGE_SIZE_NATIVE',
    bootstrapPages: 'EXPO_PUBLIC_CHAT_BOOTSTRAP_PAGES_NATIVE',
    cacheLimit: 'EXPO_PUBLIC_CHAT_CACHE_LIMIT_NATIVE',
    prefetchThreshold: 'EXPO_PUBLIC_CHAT_PREFETCH_THRESHOLD_NATIVE',
  },
  web: {
    pageSize: 'EXPO_PUBLIC_CHAT_PAGE_SIZE_WEB',
    bootstrapPages: 'EXPO_PUBLIC_CHAT_BOOTSTRAP_PAGES_WEB',
    cacheLimit: 'EXPO_PUBLIC_CHAT_CACHE_LIMIT_WEB',
    prefetchThreshold: 'EXPO_PUBLIC_CHAT_PREFETCH_THRESHOLD_WEB',
  },
};

const DEFAULTS: Record<ChatPaginationPlatform, Record<NumericSettingKey, number>> = {
  native: {
    pageSize: 24,
    bootstrapPages: 2,
    cacheLimit: 512,
    prefetchThreshold: 4,
  },
  web: {
    pageSize: 32,
    bootstrapPages: 3,
    cacheLimit: 768,
    prefetchThreshold: 6,
  },
};

const parseEnvNumber = (value: string | undefined): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
};

const clampPositiveInteger = (value: number, fallback: number, minimum: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return Math.max(minimum, fallback);
  }
  return Math.max(minimum, Math.floor(value));
};

const resolveNumericSetting = (
  platform: ChatPaginationPlatform,
  key: NumericSettingKey
): number => {
  const platformEnv = parseEnvNumber(process.env[PLATFORM_ENV_KEYS[platform][key]]);
  if (platformEnv != null) {
    return platformEnv;
  }
  const sharedEnv = parseEnvNumber(process.env[BASE_ENV_KEYS[key]]);
  if (sharedEnv != null) {
    return sharedEnv;
  }
  return DEFAULTS[platform][key];
};

export const getChatPaginationProfile = (
  platform: ChatPaginationPlatform = 'native'
): ChatPaginationProfile => {
  const pageSize = clampPositiveInteger(resolveNumericSetting(platform, 'pageSize'), DEFAULTS[platform].pageSize, 8);
  const bootstrapPages = clampPositiveInteger(
    resolveNumericSetting(platform, 'bootstrapPages'),
    DEFAULTS[platform].bootstrapPages,
    1
  );
  const cacheLimit = clampPositiveInteger(
    resolveNumericSetting(platform, 'cacheLimit'),
    DEFAULTS[platform].cacheLimit,
    pageSize * bootstrapPages
  );
  const prefetchThresholdRaw = clampPositiveInteger(
    resolveNumericSetting(platform, 'prefetchThreshold'),
    DEFAULTS[platform].prefetchThreshold,
    1
  );

  const bootstrapWindowSize = pageSize * bootstrapPages;
  const prefetchPageSize = Math.max(pageSize * 2, pageSize + 4);
  const realtimeReconcileSize = Math.max(prefetchPageSize, 200);

  return {
    platform,
    pageSize,
    bootstrapPages,
    bootstrapWindowSize,
    cacheLimit,
    prefetchThreshold: prefetchThresholdRaw,
    prefetchPageSize,
    realtimeReconcileSize,
  };
};
