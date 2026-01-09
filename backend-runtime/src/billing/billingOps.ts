import * as admin from 'firebase-admin';
import { stripUndefinedDeep } from '../lib/stripUndefinedDeep';

export type BillingOpsSeverity = 'info' | 'warn' | 'error';

export type BillingOpsEvent = {
  provider: 'razorpay' | 'stripe' | 'play' | 'app_store' | 'unknown';
  type: string;
  severity: BillingOpsSeverity;
  message: string;
  tenantId?: string | null;
  event?: string | null;
  subscriptionId?: string | null;
  paymentId?: string | null;
  webhookEventId?: string | null;
  httpStatus?: number | null;
  requestPath?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  payloadPreview?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordBillingOpsEvent(db: admin.firestore.Firestore, event: BillingOpsEvent) {
  const nowIso = new Date().toISOString();
  await db.collection('billingOpsEvents').add(
    stripUndefinedDeep({
      ...event,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtIso: nowIso,
    })
  );
}

export function safePreview(raw: unknown, max = 800): string | null {
  const text = typeof raw === 'string' ? raw : '';
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}
