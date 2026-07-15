import fetch from 'node-fetch';
import * as admin from 'firebase-admin';
import { getFirestore } from './firebaseAdmin';
import { resolveNotificationChannelId } from './lib/notificationChannels';

const MAX_EXPO_MESSAGES_PER_BATCH = 100;
const DEFAULT_EXPO_PUSH_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

export interface ExpoPushMessage extends Record<string, unknown> {
  to: string;
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  sound?: string;
  priority?: 'default' | 'normal' | 'high';
  channelId?: string;
}

export interface PushTokenRecord {
  token: string;
  deviceDocPath: string;
  deviceId?: string;
  ownerEmail?: string;
}

interface SendExpoMessagesOptions {
  attemptSplit?: boolean;
  context?: string;
  expoEndpoint?: string;
}

/**
 * Per-message delivery result, INDEX-ALIGNED to the `messages` array passed to
 * {@link sendExpoMessages} (`results[i]` describes `messages[i]`). `ok` marks a
 * delivered message; `error` carries a stable failure description otherwise.
 *
 * This positional mapping is intentional: two different device targets could in
 * theory carry the same `to` token, so callers MUST map results back by index,
 * not by token, to avoid crediting/blaming the wrong target.
 */
export interface ExpoMessageResult {
  to: string;
  ok: boolean;
  error?: string;
}

export interface SendExpoMessagesResult {
  sent: number;
  failed: number;
  invalidTokens: string[];
  /**
   * Per-message outcomes, index-aligned to the input `messages` array. The
   * aggregate `sent`/`failed` counts always equal the number of `ok`/non-`ok`
   * entries in this array (`sent === results.filter(r => r.ok).length`).
   * `invalidTokens`/`sent`/`failed` keep their original semantics for backward
   * compatibility; `results` is additive.
   */
  results: ExpoMessageResult[];
}

export async function sendExpoMessages(
  messages: ExpoPushMessage[],
  options: SendExpoMessagesOptions = {}
): Promise<SendExpoMessagesResult> {
  const { attemptSplit = true, context = 'push_utils', expoEndpoint } = options;
  const endpoint = expoEndpoint || process.env.EXPO_PUSH_ENDPOINT || DEFAULT_EXPO_PUSH_ENDPOINT;

  if (messages.length === 0) {
    return { sent: 0, failed: 0, invalidTokens: [], results: [] };
  }

  const normalizedMessages = messages.map((message) => {
    if (message.channelId) {
      return message;
    }

    const data = (message.data ?? {}) as { [key: string]: unknown };
    const type = typeof data.type === 'string' ? data.type : undefined;
    const priority = typeof data.priority === 'string' ? data.priority : undefined;

    return {
      ...message,
      channelId: resolveNotificationChannelId({ type, priority }),
    };
  });

  let sent = 0;
  let failed = 0;
  const invalidTokens = new Set<string>();
  // Pre-sized so every input message is written at its own GLOBAL index,
  // independent of chunk boundaries and recursion.
  const results: ExpoMessageResult[] = new Array(normalizedMessages.length);

  /** Record one message's failure at its global index and bump the failed count. */
  const recordFailure = (globalIndex: number, message: ExpoPushMessage, error: string): void => {
    failed += 1;
    results[globalIndex] = { to: String(message.to), ok: false, error };
  };

  /** Record one message's success at its global index and bump the sent count. */
  const recordSuccess = (globalIndex: number, message: ExpoPushMessage): void => {
    sent += 1;
    results[globalIndex] = { to: String(message.to), ok: true };
  };

  // `chunkOffset` is the index of the chunk's first message in
  // `normalizedMessages`, so `chunkOffset + localIdx` is the global index used to
  // write positional results back (chunks are contiguous slices).
  let chunkOffset = 0;
  for (const chunk of chunkArray(normalizedMessages, MAX_EXPO_MESSAGES_PER_BATCH)) {
    const offset = chunkOffset;
    chunkOffset += chunk.length;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(chunk),
      });

      const raw = await response.text();
      let parsed: any;
      if (raw) {
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = { raw };
        }
      }

      const receipts = normalizeExpoReceipts(parsed);
      if (!response.ok) {
        const invalidFromErrors = extractInvalidTokensFromError(parsed, chunk);
        invalidFromErrors.forEach(token => invalidTokens.add(token));
        console.warn(`[${context}] expo push request failed`, {
          status: response.status,
          statusText: response.statusText,
          body: parsed,
          chunkSize: chunk.length,
        });

        if (attemptSplit && chunk.length > 1) {
          console.warn(`[${context}] retrying chunk individually after failure`, { size: chunk.length });
          // Retry each message on its own; the single-message recursion returns
          // exactly one positional result, which we map back to its global index.
          for (let i = 0; i < chunk.length; i += 1) {
            const single = chunk[i];
            const result = await sendExpoMessages([single], { attemptSplit: false, context, expoEndpoint: endpoint });
            sent += result.sent;
            failed += result.failed;
            result.invalidTokens.forEach(token => invalidTokens.add(token));
            results[offset + i] = result.results[0] ?? { to: String(single.to), ok: false, error: 'expo_no_result' };
            if (!result.sent && result.failed) {
              console.warn(`[${context}] single token retry failed`, { token: single.to });
            }
          }
          continue;
        }

        const httpError = `expo_push_http_${response.status}`;
        chunk.forEach((message, i) => recordFailure(offset + i, message, httpError));
        continue;
      }

      if (receipts.length === 0) {
        chunk.forEach((message, i) => recordSuccess(offset + i, message));
        continue;
      }

      // Iterate over the CHUNK (not the receipts) so every message gets exactly
      // one positional result even if the server returns fewer receipts than
      // messages; a missing receipt is treated as a failure.
      chunk.forEach((message, idx) => {
        const receipt: any = receipts[idx];
        const status = receipt?.status;
        const token = typeof message?.to === 'string' ? String(message.to) : undefined;
        if (status === 'ok') {
          recordSuccess(offset + idx, message);
        } else {
          const receiptError =
            (typeof receipt?.message === 'string' && receipt.message) ||
            (typeof receipt?.details?.error === 'string' && receipt.details.error) ||
            (receipt === undefined ? 'expo_missing_receipt' : 'expo_receipt_error');
          recordFailure(offset + idx, message, receiptError);
          if (receipt?.message || receipt?.details) {
            console.warn(`[${context}] expo push receipt error`, {
              token,
              message: receipt?.message,
              details: receipt?.details,
            });
          }
          const invalidToken = extractInvalidTokenFromReceipt(receipt, message);
          if (invalidToken) invalidTokens.add(invalidToken);
        }
      });
    } catch (error: any) {
      console.warn(`[${context}] expo push network error`, error?.message || error);
      const networkError = typeof error?.message === 'string' && error.message ? error.message : 'expo_network_error';
      chunk.forEach((message, i) => recordFailure(offset + i, message, networkError));
    }
  }

  return { sent, failed, invalidTokens: Array.from(invalidTokens), results };
}

export async function markPushTokensInvalid(
  records: PushTokenRecord[],
  options: { context?: string } = {}
): Promise<void> {
  if (!records.length) return;

  const { context = 'push_utils' } = options;

  try {
    const db = getFirestore();
    const updatePayload = {
      expoPushToken: admin.firestore.FieldValue.delete(),
      pushTokenStatus: 'missing' as const,
      needsExpoPushTokenRefresh: true,
      lastPushTokenErrorAt: admin.firestore.FieldValue.serverTimestamp(),
      lastPushTokenErrorCode: 'DeviceNotRegistered',
    };

    for (const record of records) {
      try {
        await db.doc(record.deviceDocPath).set(updatePayload, { merge: true });
      } catch (error) {
        console.warn(`[${context}] failed to mark invalid push token`, record.deviceDocPath, error instanceof Error ? error.message : error);
      }
    }
  } catch (error) {
    console.warn(`[${context}] markPushTokensInvalid error`, error instanceof Error ? error.message : error);
  }
}

function chunkArray<T>(array: T[], size: number): T[][] {
  if (size <= 0) return [array];
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

function normalizeExpoReceipts(payload: any): any[] {
  if (!payload) return [];
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload)) return payload;
  if (payload?.data && typeof payload.data === 'object') return [payload.data];
  return [];
}

function extractInvalidTokensFromError(payload: any, fallbackChunk: ExpoPushMessage[]): string[] {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  const tokens = new Set<string>();

  for (const err of errors) {
    const token = err?.details?.expoPushToken;
    if (typeof token === 'string' && token) tokens.add(token);
    const errorCode = err?.details?.error || err?.code;
    const message = typeof err?.message === 'string' ? err.message.toLowerCase() : '';
    if (errorCode === 'DeviceNotRegistered' || message.includes('not a registered push notification recipient')) {
      fallbackChunk.forEach(msg => {
        if (typeof msg?.to === 'string') tokens.add(msg.to);
      });
    }
  }

  return Array.from(tokens);
}

function extractInvalidTokenFromReceipt(receipt: any, message: ExpoPushMessage): string | null {
  const tokenFromDetails = receipt?.details?.expoPushToken;
  if (typeof tokenFromDetails === 'string' && tokenFromDetails) return tokenFromDetails;
  const errorCode = receipt?.details?.error || receipt?.details?.code || receipt?.status;
  if (errorCode === 'DeviceNotRegistered' && typeof message?.to === 'string') return message.to;
  const text = typeof receipt?.message === 'string' ? receipt.message.toLowerCase() : '';
  if (text.includes('not a registered push notification recipient') && typeof message?.to === 'string') {
    return message.to;
  }
  return null;
}
