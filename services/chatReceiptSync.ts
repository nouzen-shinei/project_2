import { logger } from '@/lib/logger';
import { chatService } from './chatService';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ChatReceiptNotificationSource = 'received' | 'response' | 'background-task';

const deliveredReceiptSyncCache = new Set<string>();
const PENDING_RECEIPT_STORAGE_KEY = 'tm.pendingChatDeliveryReceipts.v1';
const RECEIPT_TELEMETRY_STORAGE_KEY = 'tm.chatDeliveryReceiptTelemetry.v1';
const MAX_PENDING_RECEIPTS = 400;
const MAX_PENDING_RECEIPT_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 5 * 60_000;

type PendingDeliveryReceipt = {
  key: string;
  senderEmail: string;
  messageId: string;
  tenantId?: string;
  attempts: number;
  lastAttemptAt?: number;
  nextRetryAt: number;
  createdAt: number;
};

type DeliveryReceiptTelemetry = {
  queued: number;
  retried: number;
  synced: number;
  staleDropped: number;
  lastUpdatedAt: number;
  lastFlushAt?: number;
};

const DEFAULT_DELIVERY_RECEIPT_TELEMETRY: DeliveryReceiptTelemetry = {
  queued: 0,
  retried: 0,
  synced: 0,
  staleDropped: 0,
  lastUpdatedAt: 0,
};

let pendingReceiptCache: PendingDeliveryReceipt[] | null = null;
let pendingReceiptLoadPromise: Promise<PendingDeliveryReceipt[]> | null = null;
let flushInFlight: Promise<{ synced: number; remaining: number }> | null = null;
let telemetryCache: DeliveryReceiptTelemetry | null = null;
let telemetryLoadPromise: Promise<DeliveryReceiptTelemetry> | null = null;
let lastTelemetryMetricEmitAt = 0;

function computeRetryDelay(attempts: number): number {
  const safeAttempts = Number.isFinite(attempts) && attempts > 0 ? attempts : 1;
  return Math.min(RETRY_BASE_DELAY_MS * (2 ** (safeAttempts - 1)), RETRY_MAX_DELAY_MS);
}

function buildReceiptKey(senderEmail: string, messageId: string, tenantId?: string): string {
  return `${tenantId ?? 'no_tenant'}:${senderEmail}:${messageId}`;
}

function parsePendingReceipts(raw: string | null): PendingDeliveryReceipt[] {
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .map((entry): PendingDeliveryReceipt | null => {
        if (!entry || typeof entry !== 'object') {
          return null;
        }

        const senderEmail = typeof entry.senderEmail === 'string' ? entry.senderEmail.trim().toLowerCase() : '';
        const messageId = typeof entry.messageId === 'string' ? entry.messageId.trim() : '';
        const tenantId = typeof entry.tenantId === 'string' && entry.tenantId.trim() ? entry.tenantId.trim() : undefined;
        if (!senderEmail || !messageId) {
          return null;
        }

        const key = typeof entry.key === 'string' && entry.key.trim()
          ? entry.key.trim()
          : buildReceiptKey(senderEmail, messageId, tenantId);

        const attempts = typeof entry.attempts === 'number' && Number.isFinite(entry.attempts)
          ? Math.max(0, Math.floor(entry.attempts))
          : 0;

        const createdAt = typeof entry.createdAt === 'number' && Number.isFinite(entry.createdAt)
          ? entry.createdAt
          : Date.now();

        const lastAttemptAt = typeof entry.lastAttemptAt === 'number' && Number.isFinite(entry.lastAttemptAt)
          ? entry.lastAttemptAt
          : undefined;

        const nextRetryAt = typeof entry.nextRetryAt === 'number' && Number.isFinite(entry.nextRetryAt)
          ? entry.nextRetryAt
          : Date.now();

        return {
          key,
          senderEmail,
          messageId,
          tenantId,
          attempts,
          lastAttemptAt,
          nextRetryAt,
          createdAt,
        };
      })
      .filter((entry): entry is PendingDeliveryReceipt => Boolean(entry));
  } catch {
    return [];
  }
}

function parseTelemetry(raw: string | null): DeliveryReceiptTelemetry {
  if (!raw) {
    return { ...DEFAULT_DELIVERY_RECEIPT_TELEMETRY };
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { ...DEFAULT_DELIVERY_RECEIPT_TELEMETRY };
    }

    return {
      queued: typeof parsed.queued === 'number' && Number.isFinite(parsed.queued) ? Math.max(0, Math.floor(parsed.queued)) : 0,
      retried: typeof parsed.retried === 'number' && Number.isFinite(parsed.retried) ? Math.max(0, Math.floor(parsed.retried)) : 0,
      synced: typeof parsed.synced === 'number' && Number.isFinite(parsed.synced) ? Math.max(0, Math.floor(parsed.synced)) : 0,
      staleDropped: typeof parsed.staleDropped === 'number' && Number.isFinite(parsed.staleDropped)
        ? Math.max(0, Math.floor(parsed.staleDropped))
        : 0,
      lastUpdatedAt: typeof parsed.lastUpdatedAt === 'number' && Number.isFinite(parsed.lastUpdatedAt)
        ? parsed.lastUpdatedAt
        : 0,
      lastFlushAt: typeof parsed.lastFlushAt === 'number' && Number.isFinite(parsed.lastFlushAt)
        ? parsed.lastFlushAt
        : undefined,
    };
  } catch {
    return { ...DEFAULT_DELIVERY_RECEIPT_TELEMETRY };
  }
}

function splitStalePendingReceipts(receipts: PendingDeliveryReceipt[]): {
  fresh: PendingDeliveryReceipt[];
  staleDroppedCount: number;
} {
  const now = Date.now();
  const fresh = receipts.filter((entry) => now - entry.createdAt <= MAX_PENDING_RECEIPT_AGE_MS);
  return {
    fresh,
    staleDroppedCount: receipts.length - fresh.length,
  };
}

async function loadTelemetry(): Promise<DeliveryReceiptTelemetry> {
  if (telemetryCache) {
    return telemetryCache;
  }

  if (!telemetryLoadPromise) {
    telemetryLoadPromise = (async () => {
      const raw = await AsyncStorage.getItem(RECEIPT_TELEMETRY_STORAGE_KEY);
      const parsed = parseTelemetry(raw);
      telemetryCache = parsed;
      return parsed;
    })().finally(() => {
      telemetryLoadPromise = null;
    });
  }

  return telemetryLoadPromise;
}

async function persistTelemetry(next: DeliveryReceiptTelemetry): Promise<void> {
  telemetryCache = next;
  await AsyncStorage.setItem(RECEIPT_TELEMETRY_STORAGE_KEY, JSON.stringify(next));
}

async function bumpTelemetry(delta: Partial<Pick<DeliveryReceiptTelemetry, 'queued' | 'retried' | 'synced' | 'staleDropped'>>, options: {
  markFlush?: boolean;
  remaining?: number;
} = {}): Promise<void> {
  const current = await loadTelemetry();
  const next: DeliveryReceiptTelemetry = {
    ...current,
    queued: Math.max(0, current.queued + (delta.queued ?? 0)),
    retried: Math.max(0, current.retried + (delta.retried ?? 0)),
    synced: Math.max(0, current.synced + (delta.synced ?? 0)),
    staleDropped: Math.max(0, current.staleDropped + (delta.staleDropped ?? 0)),
    lastUpdatedAt: Date.now(),
    lastFlushAt: options.markFlush ? Date.now() : current.lastFlushAt,
  };

  await persistTelemetry(next);

  const now = Date.now();
  const hasMeaningfulDelta = Boolean(
    (delta.queued ?? 0) > 0 ||
    (delta.retried ?? 0) > 0 ||
    (delta.synced ?? 0) > 0 ||
    (delta.staleDropped ?? 0) > 0
  );

  if (!hasMeaningfulDelta && !options.markFlush) {
    return;
  }

  if (now - lastTelemetryMetricEmitAt < 60_000) {
    return;
  }
  lastTelemetryMetricEmitAt = now;

  logger.metric('chat.delivery_receipt.telemetry', {
    queued: next.queued,
    retried: next.retried,
    synced: next.synced,
    staleDropped: next.staleDropped,
    remainingPending: typeof options.remaining === 'number' ? options.remaining : undefined,
  });
}

async function loadPendingReceipts(): Promise<PendingDeliveryReceipt[]> {
  if (pendingReceiptCache) {
    return pendingReceiptCache;
  }

  if (!pendingReceiptLoadPromise) {
    pendingReceiptLoadPromise = (async () => {
      const raw = await AsyncStorage.getItem(PENDING_RECEIPT_STORAGE_KEY);
      const parsed = parsePendingReceipts(raw);
      const staleSplit = splitStalePendingReceipts(parsed);
      pendingReceiptCache = staleSplit.fresh;

      if (staleSplit.staleDroppedCount > 0) {
        await persistPendingReceipts(staleSplit.fresh);
        await bumpTelemetry({ staleDropped: staleSplit.staleDroppedCount }, { remaining: staleSplit.fresh.length });
      }

      return staleSplit.fresh;
    })().finally(() => {
      pendingReceiptLoadPromise = null;
    });
  }

  return pendingReceiptLoadPromise;
}

async function persistPendingReceipts(receipts: PendingDeliveryReceipt[]): Promise<void> {
  const staleSplit = splitStalePendingReceipts(receipts);
  pendingReceiptCache = staleSplit.fresh;

  if (staleSplit.staleDroppedCount > 0) {
    await bumpTelemetry({ staleDropped: staleSplit.staleDroppedCount }, { remaining: staleSplit.fresh.length });
  }

  if (!staleSplit.fresh.length) {
    await AsyncStorage.removeItem(PENDING_RECEIPT_STORAGE_KEY);
    return;
  }

  const capped = staleSplit.fresh.slice(-MAX_PENDING_RECEIPTS);
  const overflowDropped = staleSplit.fresh.length - capped.length;
  if (overflowDropped > 0) {
    await bumpTelemetry({ staleDropped: overflowDropped }, { remaining: capped.length });
  }

  pendingReceiptCache = capped;
  await AsyncStorage.setItem(PENDING_RECEIPT_STORAGE_KEY, JSON.stringify(capped));
}

async function markReceiptAsPending(entry: PendingDeliveryReceipt): Promise<void> {
  const now = Date.now();
  const receipts = await loadPendingReceipts();
  const idx = receipts.findIndex((item) => item.key === entry.key);
  if (idx >= 0) {
    const current = receipts[idx];
    const attempts = current.attempts + 1;
    receipts[idx] = {
      ...current,
      attempts,
      lastAttemptAt: now,
      nextRetryAt: now + computeRetryDelay(attempts),
    };
    await bumpTelemetry({ retried: 1 }, { remaining: receipts.length });
  } else {
    receipts.push({
      ...entry,
      attempts: 1,
      lastAttemptAt: now,
      nextRetryAt: now + computeRetryDelay(1),
      createdAt: entry.createdAt || now,
    });
    await bumpTelemetry({ queued: 1 }, { remaining: receipts.length });
  }

  if (receipts.length > MAX_PENDING_RECEIPTS) {
    receipts.sort((a, b) => a.createdAt - b.createdAt);
  }

  await persistPendingReceipts(receipts);
}

async function clearPendingReceiptByKey(key: string): Promise<void> {
  const receipts = await loadPendingReceipts();
  const next = receipts.filter((entry) => entry.key !== key);
  if (next.length !== receipts.length) {
    await persistPendingReceipts(next);
  }
}

async function trySyncReceipt(entry: PendingDeliveryReceipt): Promise<boolean> {
  const result = await chatService.syncConversationReceipts(entry.senderEmail, {
    deliveredMessageIds: [entry.messageId],
    markConversationDelivered: false,
    tenantId: entry.tenantId,
  });

  if (result.ok !== true) {
    return false;
  }

  if (result.actorHasOnlineDevice === false) {
    return false;
  }

  return true;
}

function normalizeNotificationPayload(rawData: Record<string, any> | undefined): Record<string, any> {
  if (!rawData || typeof rawData !== 'object') {
    return {};
  }

  return Object.keys(rawData).reduce<Record<string, any>>((accumulator, key) => {
    const value = rawData[key];
    if (value !== undefined) {
      accumulator[key] = value;
    }
    return accumulator;
  }, {});
}

export async function confirmInboundChatDeliveryFromNotificationData(
  rawData: Record<string, any> | undefined,
  source: ChatReceiptNotificationSource,
  options: {
    currentUserEmail?: string | null;
  } = {}
): Promise<boolean> {
  try {
    const data = normalizeNotificationPayload(rawData);
    const type = typeof data.type === 'string' ? data.type : '';
    if (type !== 'chat_message' && type !== 'team_chat_message') {
      return false;
    }

    const messageId = typeof data.messageId === 'string' ? data.messageId.trim() : '';
    const senderEmail = typeof data.senderEmail === 'string' ? data.senderEmail.trim().toLowerCase() : '';
    const tenantId = typeof data.tenantId === 'string' && data.tenantId.trim() ? data.tenantId.trim() : undefined;
    if (!messageId || !senderEmail) {
      return false;
    }

    const currentUserEmail = typeof options.currentUserEmail === 'string'
      ? options.currentUserEmail.trim().toLowerCase()
      : '';
    if (currentUserEmail && senderEmail === currentUserEmail) {
      return false;
    }

    const dedupeKey = buildReceiptKey(senderEmail, messageId, tenantId);
    if (deliveredReceiptSyncCache.has(dedupeKey)) {
      return false;
    }

    const pendingEntry: PendingDeliveryReceipt = {
      key: dedupeKey,
      senderEmail,
      messageId,
      tenantId,
      attempts: 0,
      nextRetryAt: Date.now(),
      createdAt: Date.now(),
    };

    try {
      const synced = await trySyncReceipt(pendingEntry);
      if (synced) {
        deliveredReceiptSyncCache.add(dedupeKey);
        await clearPendingReceiptByKey(dedupeKey);
        logger.debug('Confirmed inbound chat delivery from notification signal', {
          source,
          senderEmail,
          messageId,
          tenantId,
        });
        return true;
      }
    } catch (syncError) {
      logger.debug('Immediate inbound delivery confirmation failed; queueing retry', {
        source,
        senderEmail,
        messageId,
        tenantId,
        error: syncError,
      });
    }

    await markReceiptAsPending(pendingEntry);
    return true;
  } catch (error) {
    logger.debug('Inbound chat delivery confirmation from notification failed', {
      source,
      error,
    });
    return false;
  }
}

export async function flushPendingInboundChatDeliveryReceipts(options: {
  currentUserEmail?: string | null;
  maxBatchSize?: number;
} = {}): Promise<{ synced: number; remaining: number }> {
  if (!flushInFlight) {
    flushInFlight = (async () => {
      const currentUserEmail = typeof options.currentUserEmail === 'string'
        ? options.currentUserEmail.trim().toLowerCase()
        : '';
      const maxBatchSize = typeof options.maxBatchSize === 'number' && Number.isFinite(options.maxBatchSize)
        ? Math.max(1, Math.floor(options.maxBatchSize))
        : 30;
      const now = Date.now();

      const receipts = await loadPendingReceipts();
      if (!receipts.length) {
        return { synced: 0, remaining: 0 };
      }

      const sorted = [...receipts].sort((a, b) => a.nextRetryAt - b.nextRetryAt);
      const next: PendingDeliveryReceipt[] = [];
      let processed = 0;
      let synced = 0;

      for (const entry of sorted) {
        if (processed >= maxBatchSize) {
          next.push(entry);
          continue;
        }

        if (entry.nextRetryAt > now) {
          next.push(entry);
          continue;
        }

        if (currentUserEmail && entry.senderEmail === currentUserEmail) {
          continue;
        }

        if (deliveredReceiptSyncCache.has(entry.key)) {
          continue;
        }

        processed += 1;

        try {
          const ok = await trySyncReceipt(entry);
          if (ok) {
            synced += 1;
            deliveredReceiptSyncCache.add(entry.key);
            continue;
          }
        } catch (error) {
          logger.debug('Pending inbound delivery receipt flush attempt failed', {
            key: entry.key,
            error,
          });
        }

        const attempts = entry.attempts + 1;
        next.push({
          ...entry,
          attempts,
          lastAttemptAt: now,
          nextRetryAt: now + computeRetryDelay(attempts),
        });
      }

      await persistPendingReceipts(next);
      await bumpTelemetry({ synced }, {
        markFlush: true,
        remaining: next.length,
      });
      return { synced, remaining: next.length };
    })().finally(() => {
      flushInFlight = null;
    });
  }

  return flushInFlight;
}