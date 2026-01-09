import * as admin from 'firebase-admin';
import { ensureFirebase } from './firebaseAdmin';
import { normalizeEmail, sanitizeKey } from './chatRealtime';

interface RateLimitConfig {
  id: string;
  windowMs: number;
  max: number;
}

interface BucketState {
  count: number;
  expiresAt: number;
}

interface RateLimitState {
  buckets?: Record<string, BucketState>;
  lastAttemptAt?: number;
  lastResult?: {
    allowed: boolean;
    blockedUntil?: number | null;
    timestamp: number;
  };
}

export interface RateLimitCheckResult {
  allowed: boolean;
  blockedUntil?: number;
}

const DEFAULT_LIMITS: RateLimitConfig[] = [
  {
    id: '1m',
    windowMs: Number(process.env.CHAT_RATE_LIMIT_SHORT_WINDOW_MS || 60_000),
    max: Number(process.env.CHAT_RATE_LIMIT_SHORT_MAX || 20),
  },
  {
    id: '5m',
    windowMs: Number(process.env.CHAT_RATE_LIMIT_LONG_WINDOW_MS || 300_000),
    max: Number(process.env.CHAT_RATE_LIMIT_LONG_MAX || 60),
  },
];

function getLimits(): RateLimitConfig[] {
  if (process.env.CHAT_RATE_LIMIT_DISABLED === '1' || process.env.CHAT_RATE_LIMIT_DISABLED === 'true') {
    return [];
  }

  return DEFAULT_LIMITS.filter((limit) => limit.windowMs > 0 && limit.max > 0);
}

export async function checkChatRateLimit(senderEmail: string): Promise<RateLimitCheckResult> {
  const normalizedEmail = normalizeEmail(senderEmail);
  if (!normalizedEmail) {
    return { allowed: true };
  }

  const bucketKey = sanitizeKey(normalizedEmail);
  if (!bucketKey) {
    return { allowed: true };
  }

  const limits = getLimits();
  if (!limits.length) {
    return { allowed: true };
  }

  ensureFirebase();
  const db = admin.database();
  const ref = db.ref('chatRateLimit').child(bucketKey);

  const now = Date.now();

  const result = await ref.transaction((currentValue) => {
    const currentState: RateLimitState = currentValue && typeof currentValue === 'object' ? { ...(currentValue as RateLimitState) } : {};
    const existingBuckets = currentState.buckets ?? {};

    const refreshedBuckets: Record<string, BucketState> = {};
    let allowed = true;
    let blockedUntil = 0;

    for (const limit of limits) {
      const existing = existingBuckets[limit.id];
      const validBucket = existing && typeof existing.count === 'number' && typeof existing.expiresAt === 'number'
        ? existing as BucketState
        : { count: 0, expiresAt: now + limit.windowMs };

      const bucket = now >= validBucket.expiresAt
        ? { count: 0, expiresAt: now + limit.windowMs }
        : { ...validBucket };

      if (bucket.count + 1 > limit.max) {
        allowed = false;
        blockedUntil = Math.max(blockedUntil, bucket.expiresAt);
      }

      refreshedBuckets[limit.id] = bucket;
    }

    if (!allowed) {
      return {
        ...currentState,
        buckets: refreshedBuckets,
        lastAttemptAt: now,
        lastResult: {
          allowed: false,
          blockedUntil,
          timestamp: now,
        },
      } satisfies RateLimitState;
    }

    const incrementedBuckets: Record<string, BucketState> = {};
    for (const limit of limits) {
      const bucket = refreshedBuckets[limit.id];
      incrementedBuckets[limit.id] = {
        count: bucket.count + 1,
        expiresAt: bucket.expiresAt,
      };
    }

    return {
      ...currentState,
      buckets: incrementedBuckets,
      lastAttemptAt: now,
      lastResult: {
        allowed: true,
        blockedUntil: null,
        timestamp: now,
      },
    } satisfies RateLimitState;
  });

  const snapshot = result?.snapshot?.val() as RateLimitState | undefined;
  const status = snapshot?.lastResult;

  if (status && !status.allowed) {
    return {
      allowed: false,
      blockedUntil: typeof status.blockedUntil === 'number' ? status.blockedUntil : undefined,
    };
  }

  return { allowed: true };
}
