import crypto from 'crypto';
import fetch from 'node-fetch';
import * as admin from 'firebase-admin';
import { inc } from '../metrics';
import type { PlanId } from '../lib/planLimits';
import { getPlanVariantById } from './catalog';
import { resolvePlanLimitsFromCatalog, toTenantBillingLimitsSnapshot } from '../lib/effectivePlanLimits';
import { stripUndefinedDeep } from '../lib/stripUndefinedDeep';
import { sendTenantBillingEventNotification } from './billingNotifier';

export type RazorpayWebhookEvent = {
  event?: string;
  contains?: string[];
  payload?: Record<string, any>;
  created_at?: number;
};

export interface RazorpaySubscriptionCreateResult {
  subscriptionId: string;
  shortUrl?: string;
  raw: Record<string, any>;
}

async function getCurrentTenantPlanId(
  billingRef: admin.firestore.DocumentReference
): Promise<'free' | 'pro' | 'enterprise' | null> {
  try {
    const snap = await billingRef.get();
    const data = snap.exists ? (snap.data() ?? {}) : {};
    const raw =
      typeof (data as any).planId === 'string'
        ? String((data as any).planId)
        : typeof (data as any).plan === 'string'
          ? String((data as any).plan)
          : '';
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'free' || normalized === 'pro' || normalized === 'enterprise') {
      return normalized;
    }
    return null;
  } catch {
    return null;
  }
}

function getEnv(name: string): string {
  return (process.env[name] || '').trim();
}

function getBasicAuthHeader(keyId: string, keySecret: string): string {
  const token = Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

function getRazorpayPlanIdForAppPlan(planId: PlanId): string {
  if (planId === 'pro') {
    return getEnv('RAZORPAY_PLAN_ID_PRO_MONTHLY');
  }
  return '';
}

export function verifyRazorpayWebhookSignature(options: {
  rawBody: Buffer;
  signatureHeader: string;
  webhookSecret: string;
}): boolean {
  const { rawBody } = options;
  const signatureHeader = (options.signatureHeader || '').trim().toLowerCase();
  const webhookSecret = (options.webhookSecret || '').trim();
  if (!signatureHeader || !webhookSecret) return false;

  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

export async function createRazorpaySubscription(options: {
  tenantId: string;
  planId: PlanId;
  planVariantId?: string;
  couponCode?: string;
  razorpayPlanIdOverride?: string;
  customerEmail?: string | null;
  customerNotify?: boolean;
  notes?: Record<string, string>;
}): Promise<RazorpaySubscriptionCreateResult> {
  const keyId = getEnv('RAZORPAY_KEY_ID');
  const keySecret = getEnv('RAZORPAY_KEY_SECRET');
  if (!keyId || !keySecret) {
    throw new Error('razorpay_missing_credentials');
  }

  const override = (options.razorpayPlanIdOverride || '').trim();
  const razorpayPlanId = override || getRazorpayPlanIdForAppPlan(options.planId);
  if (!razorpayPlanId) {
    throw new Error('razorpay_missing_plan_mapping');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const startAt = nowSeconds + 5 * 60; // give user a few minutes to complete checkout

  // Razorpay validates `end_time` / mandate expiry (computed from plan interval + `total_count`).
  // Large counts can exceed provider limits and fail checkout initiation, e.g.:
  // - "end_time must be between 946684800 and 4765046400"
  // - "expire_at cannot be more than 30 years for upi"
  // For monthly plans, 30 years ~= 360 cycles.
  const totalCountRaw = Number.parseInt(getEnv('RAZORPAY_SUBSCRIPTION_TOTAL_COUNT') || '360', 10);
  const totalCount = Number.isFinite(totalCountRaw) ? Math.max(1, Math.min(360, totalCountRaw)) : 360;

  const payload = {
    plan_id: razorpayPlanId,
    total_count: totalCount,
    quantity: 1,
    customer_notify: options.customerNotify === false ? 0 : 1,
    start_at: startAt,
    notes: {
      tenantId: options.tenantId,
      planId: options.planId,
      ...(options.planVariantId ? { planVariantId: options.planVariantId } : {}),
      ...(options.couponCode ? { couponCode: options.couponCode } : {}),
      ...(options.notes || {}),
    },
  };

  const response = await fetch('https://api.razorpay.com/v1/subscriptions', {
    method: 'POST',
    headers: {
      Authorization: getBasicAuthHeader(keyId, keySecret),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const raw = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    const message = typeof raw?.error?.description === 'string' ? raw.error.description : 'Razorpay subscription create failed';
    const error = new Error(message);
    (error as any).status = response.status;
    (error as any).providerPayload = raw;
    throw error;
  }

  const subscriptionId = typeof raw.id === 'string' ? raw.id : '';
  if (!subscriptionId) {
    throw new Error('razorpay_subscription_missing_id');
  }

  const shortUrl = typeof raw.short_url === 'string' ? raw.short_url : undefined;
  return { subscriptionId, shortUrl, raw };
}

export async function cancelRazorpaySubscription(options: {
  subscriptionId: string;
  cancelAtCycleEnd?: boolean;
}): Promise<{ ok: true; raw: Record<string, any> }> {
  const keyId = getEnv('RAZORPAY_KEY_ID');
  const keySecret = getEnv('RAZORPAY_KEY_SECRET');
  if (!keyId || !keySecret) {
    throw new Error('razorpay_missing_credentials');
  }

  const subscriptionId = (options.subscriptionId || '').trim();
  if (!subscriptionId) {
    throw new Error('razorpay_subscription_required');
  }

  const cancelAtCycleEnd = options.cancelAtCycleEnd === true;
  const response = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
    method: 'POST',
    headers: {
      Authorization: getBasicAuthHeader(keyId, keySecret),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ cancel_at_cycle_end: cancelAtCycleEnd ? 1 : 0 }),
  });

  const raw = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    const description = typeof raw?.error?.description === 'string' ? String(raw.error.description) : '';
    const normalized = description.trim().toLowerCase();

    // Razorpay can return a non-2xx response if the subscription is already cancelled.
    // Treat this as a successful, idempotent cancellation.
    if (response.status === 400 && normalized && normalized.includes('cancel') && normalized.includes('already')) {
      return { ok: true, raw };
    }

    const message = description || 'Razorpay subscription cancel failed';
    const error = new Error(message);
    (error as any).status = response.status;
    (error as any).providerPayload = raw;
    throw error;
  }

  return { ok: true, raw };
}

export async function fetchRazorpaySubscription(options: {
  subscriptionId: string;
}): Promise<{
  subscriptionId: string;
  shortUrl?: string;
  status?: string;
  cancelAtCycleEnd?: boolean;
  chargeAt?: number;
  currentEnd?: number;
  raw: Record<string, any>;
}> {
  const keyId = getEnv('RAZORPAY_KEY_ID');
  const keySecret = getEnv('RAZORPAY_KEY_SECRET');
  if (!keyId || !keySecret) {
    throw new Error('razorpay_missing_credentials');
  }

  const subscriptionId = (options.subscriptionId || '').trim();
  if (!subscriptionId) {
    throw new Error('razorpay_subscription_required');
  }

  const response = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'GET',
    headers: {
      Authorization: getBasicAuthHeader(keyId, keySecret),
      'Content-Type': 'application/json',
    },
  });

  const raw = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    const message = typeof raw?.error?.description === 'string' ? raw.error.description : 'Razorpay subscription fetch failed';
    const error = new Error(message);
    (error as any).status = response.status;
    (error as any).providerPayload = raw;
    throw error;
  }

  const shortUrl = typeof raw.short_url === 'string' ? raw.short_url : undefined;
  const status = typeof raw.status === 'string' ? raw.status : undefined;
  const cancelAtCycleEnd = raw.cancel_at_cycle_end === 1 || raw.cancel_at_cycle_end === true;
  const chargeAt = typeof raw.charge_at === 'number' ? raw.charge_at : undefined;
  const currentEnd = typeof raw.current_end === 'number' ? raw.current_end : undefined;
  return { subscriptionId, shortUrl, status, cancelAtCycleEnd, chargeAt, currentEnd, raw };
}

export async function resumeRazorpaySubscription(options: {
  subscriptionId: string;
}): Promise<{ ok: true; raw: Record<string, any> }> {
  const keyId = getEnv('RAZORPAY_KEY_ID');
  const keySecret = getEnv('RAZORPAY_KEY_SECRET');
  if (!keyId || !keySecret) {
    throw new Error('razorpay_missing_credentials');
  }

  const subscriptionId = (options.subscriptionId || '').trim();
  if (!subscriptionId) {
    throw new Error('razorpay_subscription_required');
  }

  // Idempotency: Razorpay returns 400 if you try to resume an already-active subscription.
  // We prefetch and treat "active" as already-resumed.
  try {
    const fetched = await fetchRazorpaySubscription({ subscriptionId });
    const status = (fetched.status || '').trim().toLowerCase();
    if (status === 'active') {
      return { ok: true, raw: fetched.raw };
    }
  } catch {
    // If prefetch fails, fall back to resume call and surface errors.
  }

  const response = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}/resume`, {
    method: 'POST',
    headers: {
      Authorization: getBasicAuthHeader(keyId, keySecret),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  const raw = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    const description = typeof raw?.error?.description === 'string' ? raw.error.description : '';
    // Razorpay returns: "subscription can't be resumed as subscription is in active state".
    // Treat that as success.
    if (description.toLowerCase().includes('active state')) {
      return { ok: true, raw };
    }

    const message = description || 'Razorpay subscription resume failed';
    const error = new Error(message);
    (error as any).status = response.status;
    (error as any).providerPayload = raw;
    throw error;
  }

  return { ok: true, raw };
}

function toIsoFromUnixSeconds(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  try {
    return new Date(value * 1000).toISOString();
  } catch {
    return undefined;
  }
}

function formatIsoIstForDisplay(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  try {
    const formatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const parts = formatter.formatToParts(date);
    const map = new Map(parts.map((p) => [p.type, p.value] as const));
    const dd = map.get('day');
    const mon = map.get('month');
    const yyyy = map.get('year');
    const hour = map.get('hour');
    const minute = map.get('minute');
    const dayPeriod = map.get('dayPeriod');

    if (dd && mon && yyyy && hour && minute && dayPeriod) {
      return `${dd} ${mon} ${yyyy}, ${hour}:${minute} ${dayPeriod} IST`;
    }
  } catch {
    // fall back below
  }

  // Fallback: manual IST conversion (UTC+05:30)
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mon = months[ist.getUTCMonth()] ?? '';
  const yyyy = ist.getUTCFullYear();
  let hour24 = ist.getUTCHours();
  const minute = String(ist.getUTCMinutes()).padStart(2, '0');
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  hour24 = hour24 % 12;
  const hour12 = hour24 === 0 ? 12 : hour24;
  return `${dd} ${mon} ${yyyy}, ${hour12}:${minute} ${ampm} IST`;
}

function maskUpiVpa(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const at = raw.indexOf('@');
  if (at > 0) {
    const user = raw.slice(0, at);
    const domain = raw.slice(at + 1);
    const prefix = user.slice(0, Math.min(2, user.length));
    return `${prefix}***@${domain}`;
  }
  const prefix = raw.slice(0, Math.min(2, raw.length));
  return `${prefix}***`;
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
async function markWebhookProcessed(db: admin.firestore.Firestore, idKey: string, record: Record<string, any>) {
  const id = sha256Hex(idKey);
  const ref = db.collection('webhookEvents').doc(id);
  const existing = await ref.get();
  if (existing.exists) {
    return { alreadyProcessed: true as const, id, ref };
  }
  await ref.set(stripUndefinedDeep({ ...record, idKey, createdAt: admin.firestore.FieldValue.serverTimestamp() }));
  return { alreadyProcessed: false as const, id, ref };
}

export async function handleRazorpayWebhook(options: {
  db: admin.firestore.Firestore;
  rawBody: string;
  parsedBody: RazorpayWebhookEvent;
}): Promise<{ ok: true; provider: 'razorpay' }> {
  const { db, rawBody, parsedBody } = options;

  const event = typeof parsedBody?.event === 'string' ? parsedBody.event : 'unknown';
  inc('billing_webhook_received_total', { provider: 'razorpay', event });
  const createdAt = typeof parsedBody?.created_at === 'number' ? parsedBody.created_at : undefined;

  const subscriptionEntity = parsedBody?.payload?.subscription?.entity;
  const paymentEntity = parsedBody?.payload?.payment?.entity;

  const subscriptionIdFromPayment = typeof paymentEntity?.subscription_id === 'string' ? paymentEntity.subscription_id : undefined;
  const subscriptionId = typeof subscriptionEntity?.id === 'string' ? subscriptionEntity.id : subscriptionIdFromPayment;
  const paymentId = typeof paymentEntity?.id === 'string' ? paymentEntity.id : undefined;

  const tenantIdFromNotes =
    typeof subscriptionEntity?.notes?.tenantId === 'string'
      ? subscriptionEntity.notes.tenantId
      : typeof paymentEntity?.notes?.tenantId === 'string'
        ? paymentEntity.notes.tenantId
        : undefined;

  const planIdFromNotesRaw =
    typeof subscriptionEntity?.notes?.planId === 'string'
      ? subscriptionEntity.notes.planId
      : typeof paymentEntity?.notes?.planId === 'string'
        ? paymentEntity.notes.planId
        : undefined;

  const planVariantIdFromNotes =
    typeof subscriptionEntity?.notes?.planVariantId === 'string'
      ? subscriptionEntity.notes.planVariantId
      : typeof paymentEntity?.notes?.planVariantId === 'string'
        ? paymentEntity.notes.planVariantId
        : undefined;

  const couponCodeFromNotes =
    typeof subscriptionEntity?.notes?.couponCode === 'string'
      ? subscriptionEntity.notes.couponCode
      : typeof paymentEntity?.notes?.couponCode === 'string'
        ? paymentEntity.notes.couponCode
        : undefined;

  const planIdFromNotes = (planIdFromNotesRaw === 'pro' || planIdFromNotesRaw === 'enterprise') ? planIdFromNotesRaw : 'pro';

  if (!tenantIdFromNotes) {
    // We intentionally accept the webhook but cannot attach it to a tenant.
    return { ok: true, provider: 'razorpay' };
  }

  // If a tenant is actively checking out, any billing webhook indicates the flow progressed.
  // Clear the lock so other admins aren't blocked indefinitely.
  try {
    await db.collection('billingCheckoutLocks').doc(tenantIdFromNotes).delete();
  } catch {
    // ignore
  }

  const idKey = `razorpay:${event}:${createdAt || 'na'}:${subscriptionId || 'na'}:${paymentId || 'na'}:${tenantIdFromNotes}`;
  const { alreadyProcessed, id: webhookEventId, ref: webhookEventRef } = await markWebhookProcessed(db, idKey, {
    provider: 'razorpay',
    event,
    tenantId: tenantIdFromNotes,
    subscriptionId: subscriptionId || null,
    paymentId: paymentId || null,
    receivedAtUnix: createdAt || null,
  });

  if (alreadyProcessed) {
    inc('billing_webhook_idempotency_hits_total', { provider: 'razorpay', event });
    return { ok: true, provider: 'razorpay' };
  }

  let processingOutcome: 'ok' | 'error' = 'ok';
  const processingStartedIso = new Date().toISOString();
  try {

  const billingRef = db.collection('tenantBilling').doc(tenantIdFromNotes);
  const billingSnap = await billingRef.get().catch(() => null);
  const billingData = billingSnap && (billingSnap as any).exists ? (billingSnap as any).data?.() ?? {} : {};
  const billingAttemptId = typeof (billingData as any).billingAttemptId === 'string' ? String((billingData as any).billingAttemptId).trim() : '';

  async function logBillingAuditEvent(action: string, metadata: Record<string, unknown>) {
    try {
      await db.collection('tenantAuditLogs').add(
        stripUndefinedDeep({
          tenantId: tenantIdFromNotes,
          actorId: 'system',
          actorEmail: undefined,
          action,
          targetType: 'billing',
          metadata,
          createdAt: new Date().toISOString(),
        })
      );
    } catch {
      // ignore
    }
  }

  function getAuditActionForEvent(event: string): string {
    switch (event) {
      case 'payment.captured':
        return 'billing_payment_captured';
      case 'payment.failed':
        // Keep compatibility with existing UI labels.
        return 'billing_subscription_payment_failed';
      case 'subscription.authenticated':
        return 'billing_subscription_authenticated';
      case 'subscription.activated':
        return 'billing_subscription_activated';
      case 'subscription.charged':
        return 'billing_subscription_charged';
      case 'subscription.pending':
        return 'billing_subscription_pending';
      case 'subscription.failed':
        return 'billing_subscription_failed';
      case 'subscription.halted':
        return 'billing_subscription_halted';
      case 'subscription.cancelled':
        return 'billing_subscription_cancelled';
      case 'subscription.completed':
        return 'billing_subscription_completed';
      default:
        return 'billing_webhook_received';
    }
  }

  const auditAction = getAuditActionForEvent(event);
  if (auditAction === 'billing_webhook_received') {
    inc('billing_webhook_unknown_events_total', { provider: 'razorpay', event });
  }

  const subscriptionStatusRaw = typeof subscriptionEntity?.status === 'string' ? subscriptionEntity.status : '';
  const subscriptionStatus = subscriptionStatusRaw ? subscriptionStatusRaw.trim().toLowerCase() : null;
  const paymentStatusRaw = typeof paymentEntity?.status === 'string' ? paymentEntity.status : '';
  const paymentStatus = paymentStatusRaw ? paymentStatusRaw.trim().toLowerCase() : null;
  const currencyRaw = typeof paymentEntity?.currency === 'string' ? paymentEntity.currency : '';
  const currency = currencyRaw ? currencyRaw.trim().toUpperCase() : null;
  const amountPaise = typeof paymentEntity?.amount === 'number' ? paymentEntity.amount : null;
  const amountInr = typeof amountPaise === 'number' && Number.isFinite(amountPaise) ? Math.round(amountPaise / 100) : null;
  const renewalDate = toIsoFromUnixSeconds(subscriptionEntity?.current_end);
  const errorCode = typeof paymentEntity?.error_code === 'string' ? paymentEntity.error_code : null;
  const errorDescription = typeof paymentEntity?.error_description === 'string' ? paymentEntity.error_description : null;

  const createdByEmailRaw =
    typeof subscriptionEntity?.notes?.createdByEmail === 'string'
      ? subscriptionEntity.notes.createdByEmail
      : typeof paymentEntity?.notes?.createdByEmail === 'string'
        ? paymentEntity.notes.createdByEmail
        : '';
  const createdByEmail = createdByEmailRaw ? createdByEmailRaw.trim().toLowerCase() : null;
  const createdByUidRaw =
    typeof subscriptionEntity?.notes?.createdByUid === 'string'
      ? subscriptionEntity.notes.createdByUid
      : typeof paymentEntity?.notes?.createdByUid === 'string'
        ? paymentEntity.notes.createdByUid
        : '';
  const createdByUid = createdByUidRaw ? createdByUidRaw.trim() : null;
  const createdByRoleRaw =
    typeof subscriptionEntity?.notes?.createdByRole === 'string'
      ? subscriptionEntity.notes.createdByRole
      : typeof paymentEntity?.notes?.createdByRole === 'string'
        ? paymentEntity.notes.createdByRole
        : '';
  const createdByRole = createdByRoleRaw ? createdByRoleRaw.trim() : null;
  const createdByMembershipIdRaw =
    typeof subscriptionEntity?.notes?.createdByMembershipId === 'string'
      ? subscriptionEntity.notes.createdByMembershipId
      : typeof paymentEntity?.notes?.createdByMembershipId === 'string'
        ? paymentEntity.notes.createdByMembershipId
        : '';
  const createdByMembershipId = createdByMembershipIdRaw ? createdByMembershipIdRaw.trim() : null;

  const payerEmailRaw = typeof paymentEntity?.email === 'string' ? paymentEntity.email : '';
  const payerEmail = payerEmailRaw ? payerEmailRaw.trim().toLowerCase() : null;

  const paymentMethodRaw = typeof paymentEntity?.method === 'string' ? paymentEntity.method : '';
  const paymentMethod = paymentMethodRaw ? paymentMethodRaw.trim().toLowerCase() : null;
  const cardLast4Raw = typeof paymentEntity?.card?.last4 === 'string' ? paymentEntity.card.last4 : '';
  const cardLast4 = cardLast4Raw ? cardLast4Raw.trim() : null;
  const cardNetworkRaw = typeof paymentEntity?.card?.network === 'string' ? paymentEntity.card.network : '';
  const cardNetwork = cardNetworkRaw ? cardNetworkRaw.trim() : null;
  const upiVpaMasked = maskUpiVpa(
    typeof paymentEntity?.vpa === 'string'
      ? paymentEntity.vpa
      : typeof paymentEntity?.upi?.vpa === 'string'
        ? paymentEntity.upi.vpa
        : null
  );

  const subscriptionPeriodStart = toIsoFromUnixSeconds(subscriptionEntity?.current_start);
  const subscriptionPeriodEnd = toIsoFromUnixSeconds(subscriptionEntity?.current_end);

  // Record every billing webhook event into tenant audit logs (exactly once per webhook).
  // Keep metadata compact (full payload is already stored in `webhookEvents`).
  void logBillingAuditEvent(auditAction, {
    provider: 'razorpay',
    event,
    receivedAtUnix: createdAt || null,
    planId: planIdFromNotes,
    planVariantId: planVariantIdFromNotes || null,
    couponCode: couponCodeFromNotes || null,
    subscriptionId: subscriptionId || null,
    paymentId: paymentId || null,
    subscriptionStatus,
    paymentStatus,
    method: paymentMethod || null,
    currency,
    amountInr,
    renewalDate: renewalDate || null,
    billingPeriodStart: subscriptionPeriodStart || null,
    billingPeriodEnd: subscriptionPeriodEnd || null,
    payerEmail: payerEmail || null,
    createdByEmail: createdByEmail || null,
    createdByUid: createdByUid || null,
    createdByRole: createdByRole || null,
    createdByMembershipId: createdByMembershipId || null,
    errorCode,
    errorDescription,
  }).catch(() => undefined);

  async function resolveInvoiceRefForPayment(options: {
    tenantId: string;
    paymentId: string;
    subscriptionId?: string;
  }) {
    const invoicesCol = db.collection('billingInvoices').doc(options.tenantId).collection('invoices');

    const normalizedSubscriptionId = (options.subscriptionId || '').trim();
    if (!normalizedSubscriptionId) {
      return invoicesCol.doc(options.paymentId);
    }

    // Prefer updating an existing "open" invoice (created from subscription.authenticated)
    // to avoid duplicate records when payment status transitions to paid/failed.
    try {
      const openSnap = await invoicesCol
        .where('providerSubscriptionId', '==', normalizedSubscriptionId)
        .where('status', '==', 'open')
        .limit(1)
        .get();
      if (!openSnap.empty) {
        return openSnap.docs[0].ref;
      }
    } catch {
      // ignore and fall back to payment-id keyed record
    }

    return invoicesCol.doc(options.paymentId);
  }

  async function resolveOpenInvoiceRefForSubscriptionCycle(options: {
    tenantId: string;
    subscriptionId: string;
    billingPeriodStart?: string | null;
    billingPeriodEnd?: string | null;
    limit?: number;
  }) {
    const tenantId = (options.tenantId || '').trim();
    const subscriptionId = (options.subscriptionId || '').trim();
    if (!tenantId || !subscriptionId) return null;

    const invoicesCol = db.collection('billingInvoices').doc(tenantId).collection('invoices');
    const max = Math.max(1, Math.min(25, Math.trunc(options.limit ?? 25)));

    try {
      // Query only by providerSubscriptionId, then filter in-memory (avoids composite indexes).
      const snap = await invoicesCol.where('providerSubscriptionId', '==', subscriptionId).limit(max).get();
      if (snap.empty) return null;

      const start = options.billingPeriodStart || null;
      const end = options.billingPeriodEnd || null;

      const openDocs = snap.docs.filter((doc) => {
        const data = doc.data() || {};
        return (data as any).status === 'open';
      });
      if (!openDocs.length) return null;

      if (start || end) {
        const exact = openDocs.find((doc) => {
          const data = doc.data() || {};
          const s = typeof (data as any).billingPeriodStart === 'string' ? (data as any).billingPeriodStart : null;
          const e = typeof (data as any).billingPeriodEnd === 'string' ? (data as any).billingPeriodEnd : null;
          return (start ? s === start : true) && (end ? e === end : true);
        });
        if (exact) return exact.ref;
      }

      return openDocs[0].ref;
    } catch {
      return null;
    }
  }

  async function updateOpenInvoicesForSubscription(options: {
    tenantId: string;
    subscriptionId: string;
    patch: Record<string, unknown>;
    limit?: number;
  }) {
    const tenantId = (options.tenantId || '').trim();
    const subscriptionId = (options.subscriptionId || '').trim();
    if (!tenantId || !subscriptionId) return;

    const invoicesCol = db.collection('billingInvoices').doc(tenantId).collection('invoices');
    const max = Math.max(1, Math.min(25, Math.trunc(options.limit ?? 10)));
    try {
      // Query only by providerSubscriptionId (single-field index), then filter status in-memory
      // to avoid composite index requirements.
      const snap = await invoicesCol.where('providerSubscriptionId', '==', subscriptionId).limit(max).get();
      if (snap.empty) return;
      const updates = snap.docs
        .filter((doc) => {
          const data = doc.data() || {};
          return (data as any).status === 'open';
        })
        .map((doc) => doc.ref.set(options.patch, { merge: true }));
      if (updates.length) {
        const results = await Promise.allSettled(updates);
        const failures = results.filter((r) => r.status === 'rejected').length;
        if (failures) {
          const rawEvent = typeof (options.patch as any)?.rawEvent === 'string' ? String((options.patch as any).rawEvent) : 'unknown';
          for (let i = 0; i < failures; i++) {
            inc('billing_invoice_write_failures_total', {
              provider: 'razorpay',
              event: rawEvent,
              operation: 'update_open_invoice',
            });
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // Successful payment capture events. In some cases Razorpay emits a `payment.captured`
  // event with a fully-populated payment entity, while `subscription.charged` may not
  // include it. We persist an invoice record so the Billing History page can show it.
  // Note: We treat this as the source-of-truth for "actual payment made" notifications.
  if (event === 'payment.captured') {
    if (paymentId) {
      const amountPaise = typeof paymentEntity?.amount === 'number' ? paymentEntity.amount : 0;
      const amountInr = Math.round(amountPaise / 100);
      const issuedAt = toIsoFromUnixSeconds(typeof paymentEntity?.created_at === 'number' ? paymentEntity.created_at : createdAt);
      const capturedAt = toIsoFromUnixSeconds(
        typeof paymentEntity?.captured_at === 'number'
          ? paymentEntity.captured_at
          : typeof paymentEntity?.created_at === 'number'
            ? paymentEntity.created_at
            : createdAt
      );
      const authorizedAt = toIsoFromUnixSeconds(
        typeof paymentEntity?.authorized_at === 'number'
          ? paymentEntity.authorized_at
          : typeof paymentEntity?.created_at === 'number'
            ? paymentEntity.created_at
            : createdAt
      );
      const targetRef = await resolveInvoiceRefForPayment({
        tenantId: tenantIdFromNotes,
        paymentId,
        subscriptionId: subscriptionId || undefined,
      });
      try {
        await targetRef.set(
          {
            amountInr,
            status: 'paid',
            provider: 'razorpay',
            issuedAt: issuedAt || new Date().toISOString(),
            planId: planIdFromNotes,
            planVariantId: planVariantIdFromNotes || null,
            couponCode: couponCodeFromNotes || null,
            isSynthetic: false,
            sourceEvent: event,
            providerPaymentId: paymentId,
            providerSubscriptionId: subscriptionId || null,
            subscriptionId: subscriptionId || null,
            ...(billingAttemptId ? { billingAttemptId } : {}),
            rawEvent: event,
            payerEmail: payerEmail || null,
            method: paymentMethod || null,
            cardLast4: cardLast4 || null,
            cardNetwork: cardNetwork || null,
            upiVpaMasked: upiVpaMasked || null,
            authorizedAt: authorizedAt || null,
            capturedAt: capturedAt || null,
            billingPeriodStart: subscriptionPeriodStart || null,
            billingPeriodEnd: subscriptionPeriodEnd || null,
            createdByEmail: createdByEmail || null,
            createdByUid: createdByUid || null,
            createdByRole: createdByRole || null,
            createdByMembershipId: createdByMembershipId || null,
          },
          { merge: true }
        );
      } catch (error) {
        inc('billing_invoice_write_failures_total', { provider: 'razorpay', event, operation: 'upsert_paid_invoice' });
        throw error;
      }

      // Decide whether this is the first captured payment for this subscription.
      // If yes, send a "Subscription activated" notification (email + push + in-app notice).
      // Otherwise, send a normal "payment received" notification.
      let shouldSendActivated = false;
      let renewalDateIso: string | null = null;
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(billingRef);
          const data = snap.exists ? snap.data() ?? {} : {};
          const lastNotifiedSub = typeof (data as any).activationNotifiedSubscriptionId === 'string'
            ? (data as any).activationNotifiedSubscriptionId
            : null;

          if (subscriptionId && lastNotifiedSub !== subscriptionId) {
            shouldSendActivated = true;
          }

          renewalDateIso = typeof (data as any).renewalDate === 'string' ? (data as any).renewalDate : null;
          const nowIso = new Date().toISOString();

          tx.set(
            billingRef,
            stripUndefinedDeep({
              lastPaymentCapturedAt: admin.firestore.FieldValue.serverTimestamp(),
              lastPaymentCapturedAtIso: nowIso,
              lastPaymentCapturedPaymentId: paymentId,
              lastPaymentCapturedSubscriptionId: subscriptionId || null,
              ...(shouldSendActivated && subscriptionId
                ? {
                    activationNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
                    activationNotifiedAtIso: nowIso,
                    activationNotifiedSubscriptionId: subscriptionId,
                  }
                : {}),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }),
            { merge: true }
          );
        });
      } catch {
        inc('billing_state_write_failures_total', { provider: 'razorpay', event, operation: 'tenantBilling_activation_tx' });
        // ignore
      }

      const renewalDateDisplay = formatIsoIstForDisplay(renewalDateIso || undefined);
      const bodyLines: string[] = [];
      if (shouldSendActivated) {
        bodyLines.push(`Your ${planIdFromNotes.toUpperCase()} subscription is activated.`);
      } else {
        bodyLines.push(`Payment received for the ${planIdFromNotes.toUpperCase()} plan.`);
      }
      if (amountInr > 0) bodyLines.push(`Amount: ₹${amountInr}.`);
      if (renewalDateDisplay) bodyLines.push(`Next billing: ${renewalDateDisplay}.`);

      void sendTenantBillingEventNotification({
        tenantId: tenantIdFromNotes,
        tenantName: undefined,
        kind: shouldSendActivated ? 'subscription_activated' : 'subscription_charged',
        title: shouldSendActivated ? 'Subscription activated' : 'Subscription payment received',
        body: bodyLines.join('\n'),
        priority: 'medium',
        metadata: {
          provider: 'razorpay',
          planId: planIdFromNotes,
          subscriptionId: subscriptionId || null,
          paymentId,
          renewalDate: renewalDateIso || null,
          payerEmail: payerEmail || null,
          createdByEmail: createdByEmail || null,
          createdByUid: createdByUid || null,
          createdByRole: createdByRole || null,
          createdByMembershipId: createdByMembershipId || null,
        },
      }).catch(() => undefined);
    }

    return { ok: true, provider: 'razorpay' };
  }

  // Explicit failure events (best-effort). These can occur in addition to subscription.pending.
  if (event === 'payment.failed') {
    // Do not mark a Free tenant delinquent due to an unpaid initial checkout attempt.
    const currentPlanId = await getCurrentTenantPlanId(billingRef);
    if (currentPlanId === 'free') {
      return { ok: true, provider: 'razorpay' };
    }

    try {
      await billingRef.set(
        {
          planId: planIdFromNotes,
          planVariantId: planVariantIdFromNotes || null,
          couponCode: couponCodeFromNotes || null,
          status: 'delinquent',
          billingProvider: 'razorpay',
          subscriptionId: subscriptionId || null,
          delinquentSince: admin.firestore.FieldValue.serverTimestamp(),
          delinquentSinceIso: new Date().toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      inc('billing_state_write_failures_total', { provider: 'razorpay', event, operation: 'tenantBilling_set' });
      throw error;
    }

    const amountPaise = typeof paymentEntity?.amount === 'number' ? paymentEntity.amount : 0;
    const amountInr = Math.round(amountPaise / 100);
    const reason = typeof paymentEntity?.error_description === 'string' ? paymentEntity.error_description.trim() : '';
    const reasonSuffix = reason ? `Reason: ${reason}` : '';
    const amountSuffix = amountInr > 0 ? `Amount: ₹${amountInr}.` : '';

    if (paymentId) {
      const issuedAt = toIsoFromUnixSeconds(typeof paymentEntity?.created_at === 'number' ? paymentEntity.created_at : createdAt);
      const failedAt = issuedAt || new Date().toISOString();
      const targetRef = await resolveInvoiceRefForPayment({
        tenantId: tenantIdFromNotes,
        paymentId,
        subscriptionId: subscriptionId || undefined,
      });
      try {
        await targetRef.set(
          {
            amountInr,
            status: 'failed',
            provider: 'razorpay',
            issuedAt: issuedAt || new Date().toISOString(),
            planId: planIdFromNotes,
            planVariantId: planVariantIdFromNotes || null,
            couponCode: couponCodeFromNotes || null,
            isSynthetic: false,
            sourceEvent: event,
            providerPaymentId: paymentId,
            providerSubscriptionId: subscriptionId || null,
            subscriptionId: subscriptionId || null,
            rawEvent: event,
            payerEmail: payerEmail || null,
            method: paymentMethod || null,
            cardLast4: cardLast4 || null,
            cardNetwork: cardNetwork || null,
            upiVpaMasked: upiVpaMasked || null,
            failedAt,
            billingPeriodStart: subscriptionPeriodStart || null,
            billingPeriodEnd: subscriptionPeriodEnd || null,
            createdByEmail: createdByEmail || null,
            createdByUid: createdByUid || null,
            createdByRole: createdByRole || null,
            createdByMembershipId: createdByMembershipId || null,
            errorCode: typeof paymentEntity?.error_code === 'string' ? paymentEntity.error_code : null,
            errorDescription: typeof paymentEntity?.error_description === 'string' ? paymentEntity.error_description : null,
          },
          { merge: true }
        );
      } catch (error) {
        inc('billing_invoice_write_failures_total', { provider: 'razorpay', event, operation: 'upsert_failed_invoice' });
        throw error;
      }
    }

    void sendTenantBillingEventNotification({
      tenantId: tenantIdFromNotes,
      tenantName: undefined,
      kind: 'payment_failed',
      title: 'Subscription payment failed',
      body: [
        'A subscription payment failed.',
        ...(amountSuffix ? [amountSuffix] : []),
        'Please update your payment method to avoid interruption.',
        ...(reasonSuffix ? [reasonSuffix] : []),
      ].join('\n'),
      priority: 'high',
      metadata: {
        provider: 'razorpay',
        planId: planIdFromNotes,
        subscriptionId: subscriptionId || null,
        paymentId: paymentId || null,
        payerEmail: payerEmail || null,
        createdByEmail: createdByEmail || null,
        createdByUid: createdByUid || null,
        createdByRole: createdByRole || null,
        createdByMembershipId: createdByMembershipId || null,
        errorCode: typeof paymentEntity?.error_code === 'string' ? paymentEntity.error_code : null,
        errorDescription: typeof paymentEntity?.error_description === 'string' ? paymentEntity.error_description : null,
      },
    }).catch(() => undefined);

    return { ok: true, provider: 'razorpay' };
  }

  if (event === 'subscription.failed' || event === 'subscription.halted') {
    // If an "open" invoice was created earlier (e.g., mandate authenticated), mark it failed.
    if (subscriptionId) {
      const nowIso = new Date().toISOString();
      await updateOpenInvoicesForSubscription({
        tenantId: tenantIdFromNotes,
        subscriptionId,
        patch: {
          status: 'failed',
          sourceEvent: event,
          rawEvent: event,
          failedAt: nowIso,
          planId: planIdFromNotes,
          planVariantId: planVariantIdFromNotes || null,
          couponCode: couponCodeFromNotes || null,
          provider: 'razorpay',
          providerSubscriptionId: subscriptionId,
          subscriptionId,
          ...(billingAttemptId ? { billingAttemptId } : {}),
        },
      });
    }

    // If the tenant is currently on Free, do not upgrade them or mark them delinquent.
    const currentPlanId = await getCurrentTenantPlanId(billingRef);
    if (currentPlanId === 'free') {
      return { ok: true, provider: 'razorpay' };
    }

    try {
      await billingRef.set(
        {
          planId: planIdFromNotes,
          planVariantId: planVariantIdFromNotes || null,
          couponCode: couponCodeFromNotes || null,
          status: 'delinquent',
          billingProvider: 'razorpay',
          subscriptionId: subscriptionId || null,
          delinquentSince: admin.firestore.FieldValue.serverTimestamp(),
          delinquentSinceIso: new Date().toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      inc('billing_state_write_failures_total', { provider: 'razorpay', event, operation: 'tenantBilling_set' });
      throw error;
    }

    void sendTenantBillingEventNotification({
      tenantId: tenantIdFromNotes,
      tenantName: undefined,
      kind: 'subscription_failed',
      title: 'Subscription issue',
      body: [
        'There was an issue with your subscription.',
        'Please update your payment method to avoid any interruption.',
      ].join('\n'),
      priority: 'high',
      metadata: {
        provider: 'razorpay',
        planId: planIdFromNotes,
        subscriptionId: subscriptionId || null,
        rawEvent: event,
      },
    }).catch(() => undefined);

    return { ok: true, provider: 'razorpay' };
  }

  // Note: For some payment methods (e.g., UPI AutoPay/mandates), Razorpay may emit
  // `subscription.authenticated` when the user completes checkout, and `subscription.charged`
  // may arrive later (or not immediately). We treat authenticated as "good standing" so the
  // app upgrades right after checkout.
  if (event === 'subscription.charged' || event === 'subscription.activated' || event === 'subscription.authenticated') {
    const isAuthenticatedEvent = event === 'subscription.authenticated';
    const currentEnd = subscriptionEntity?.current_end;
    const renewalDate = toIsoFromUnixSeconds(currentEnd);
    const renewalDateDisplay = formatIsoIstForDisplay(renewalDate);

    let limitsSnapshot: ReturnType<typeof toTenantBillingLimitsSnapshot> | null = null;
    try {
      const resolved = await resolvePlanLimitsFromCatalog(db, {
        planId: planIdFromNotes,
        planVariantId: planVariantIdFromNotes || null,
      });
      limitsSnapshot = toTenantBillingLimitsSnapshot(resolved);
    } catch {
      limitsSnapshot = null;
    }

    try {
      await billingRef.set(
        {
          planId: planIdFromNotes,
          planVariantId: planVariantIdFromNotes || null,
          couponCode: couponCodeFromNotes || null,
          status: 'active',
          billingProvider: 'razorpay',
          subscriptionId: subscriptionId || null,
          renewalDate: renewalDate || null,
          checkoutRequired: false,
          billingAttemptId: admin.firestore.FieldValue.delete(),
          checkoutRequiredProvider: admin.firestore.FieldValue.delete(),
          checkoutRequiredSinceIso: admin.firestore.FieldValue.delete(),
          cancelAtCycleEnd: admin.firestore.FieldValue.delete(),
          scheduledDowngradePlanId: admin.firestore.FieldValue.delete(),
          scheduledDowngradeAt: admin.firestore.FieldValue.delete(),
          ...(limitsSnapshot ? { limitsSnapshot, limitsSnapshotAt: admin.firestore.FieldValue.serverTimestamp() } : {}),
          delinquentSince: admin.firestore.FieldValue.delete(),
          delinquentSinceIso: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      inc('billing_state_write_failures_total', { provider: 'razorpay', event, operation: 'tenantBilling_set' });
      throw error;
    }

    // Keep tenant doc in sync with billing for enforcement/UI.
    try {
      await db.collection('tenants').doc(tenantIdFromNotes).set(
        {
          billingTier: planIdFromNotes,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch {
      inc('billing_state_write_failures_total', { provider: 'razorpay', event, operation: 'tenants_billingTier_set' });
      // ignore
    }

    // Persist an invoice record even when Razorpay doesn't include `payload.payment.entity`.
    // Accounting rule: without a real paymentId/capture, we keep the invoice as "open".
    if (!paymentId && subscriptionId) {
      let amountInr = 0;
      try {
        if (planVariantIdFromNotes) {
          const variant = await getPlanVariantById(db, planVariantIdFromNotes);
          if (variant && Number.isFinite(variant.priceInr)) {
            amountInr = Math.max(0, Math.trunc(variant.priceInr));
          }
        }
      } catch {
        amountInr = 0;
      }

      const issuedAt = toIsoFromUnixSeconds(createdAt) || new Date().toISOString();
      const syntheticId = `sub_${subscriptionId}_${subscriptionPeriodEnd || issuedAt}_open`;

      const existingRef = await resolveOpenInvoiceRefForSubscriptionCycle({
        tenantId: tenantIdFromNotes,
        subscriptionId,
        billingPeriodStart: subscriptionPeriodStart || null,
        billingPeriodEnd: subscriptionPeriodEnd || null,
      });

      try {
        await db
          .collection('billingInvoices')
          .doc(tenantIdFromNotes)
          .collection('invoices')
          .doc(existingRef ? existingRef.id : syntheticId)
          .set(
            {
              amountInr,
              status: 'open',
              provider: 'razorpay',
              issuedAt,
              planId: planIdFromNotes,
              planVariantId: planVariantIdFromNotes || null,
              couponCode: couponCodeFromNotes || null,
              isSynthetic: true,
              sourceEvent: event,
              providerPaymentId: null,
              providerSubscriptionId: subscriptionId || null,
              subscriptionId: subscriptionId || null,
              rawEvent: event,
              payerEmail: payerEmail || null,
              method: paymentMethod || null,
              cardLast4: cardLast4 || null,
              cardNetwork: cardNetwork || null,
              upiVpaMasked: upiVpaMasked || null,
              billingPeriodStart: subscriptionPeriodStart || null,
              billingPeriodEnd: subscriptionPeriodEnd || null,
              createdByEmail: createdByEmail || null,
              createdByUid: createdByUid || null,
              createdByRole: createdByRole || null,
              createdByMembershipId: createdByMembershipId || null,
            },
            { merge: true }
          );
      } catch (error) {
        inc('billing_invoice_write_failures_total', { provider: 'razorpay', event, operation: 'upsert_open_invoice' });
        throw error;
      }
    }

    // Notification policy:
    // - subscription.authenticated: push-only (no email, no notice)
    // - subscription.activated/charged: notify only when actual payment is captured (payment.captured)
    if (isAuthenticatedEvent) {
      const bodyLines: string[] = [`Your ${planIdFromNotes.toUpperCase()} subscription is authenticated.`];
      if (renewalDateDisplay) bodyLines.push(`Next billing: ${renewalDateDisplay}.`);
      void sendTenantBillingEventNotification({
        tenantId: tenantIdFromNotes,
        tenantName: undefined,
        kind: 'subscription_charged',
        title: 'Subscription authenticated',
        body: bodyLines.join('\n'),
        priority: 'low',
        sendEmail: false,
        createNotice: false,
        metadata: {
          provider: 'razorpay',
          planId: planIdFromNotes,
          subscriptionId: subscriptionId || null,
          renewalDate: renewalDate || null,
          createdByEmail: createdByEmail || null,
          createdByUid: createdByUid || null,
          createdByRole: createdByRole || null,
          createdByMembershipId: createdByMembershipId || null,
        },
      }).catch(() => undefined);
    }

    return { ok: true, provider: 'razorpay' };
  }

  if (event === 'subscription.pending') {
    // Payment attempt did not complete. Keep invoice as open but record the latest event.
    if (subscriptionId) {
      await updateOpenInvoicesForSubscription({
        tenantId: tenantIdFromNotes,
        subscriptionId,
        patch: {
          status: 'open',
          sourceEvent: event,
          rawEvent: event,
          planId: planIdFromNotes,
          planVariantId: planVariantIdFromNotes || null,
          couponCode: couponCodeFromNotes || null,
          provider: 'razorpay',
          providerSubscriptionId: subscriptionId,
          subscriptionId,
          ...(billingAttemptId ? { billingAttemptId } : {}),
        },
      });
    }

    // A started-but-unpaid initial checkout can yield pending events.
    // If the tenant is currently on Free, do not upgrade them or mark them delinquent.
    const currentPlanId = await getCurrentTenantPlanId(billingRef);
    if (currentPlanId === 'free') {
      return { ok: true, provider: 'razorpay' };
    }

    try {
      await billingRef.set(
        {
          planId: planIdFromNotes,
          planVariantId: planVariantIdFromNotes || null,
          couponCode: couponCodeFromNotes || null,
          status: 'delinquent',
          billingProvider: 'razorpay',
          subscriptionId: subscriptionId || null,
          checkoutRequired: true,
          checkoutRequiredProvider: 'razorpay',
          delinquentSince: admin.firestore.FieldValue.serverTimestamp(),
          delinquentSinceIso: new Date().toISOString(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      inc('billing_state_write_failures_total', { provider: 'razorpay', event, operation: 'tenantBilling_set' });
      throw error;
    }

    void sendTenantBillingEventNotification({
      tenantId: tenantIdFromNotes,
      tenantName: undefined,
      kind: 'subscription_pending',
      title: 'Subscription payment pending',
      body: [
        'Your subscription payment is pending.',
        'Please update your payment method to avoid any interruption.',
      ].join('\n'),
      priority: 'high',
      metadata: {
        provider: 'razorpay',
        planId: planIdFromNotes,
        subscriptionId: subscriptionId || null,
        createdByEmail: createdByEmail || null,
        createdByUid: createdByUid || null,
        createdByRole: createdByRole || null,
        createdByMembershipId: createdByMembershipId || null,
      },
    }).catch(() => undefined);
    return { ok: true, provider: 'razorpay' };
  }

  if (event === 'subscription.completed' || event === 'subscription.cancelled' || event === 'subscription.expired') {
    // If an open invoice exists for this subscription, mark it void.
    if (subscriptionId) {
      await updateOpenInvoicesForSubscription({
        tenantId: tenantIdFromNotes,
        subscriptionId,
        patch: {
          status: 'void',
          sourceEvent: event,
          rawEvent: event,
          planId: planIdFromNotes,
          planVariantId: planVariantIdFromNotes || null,
          couponCode: couponCodeFromNotes || null,
          provider: 'razorpay',
          providerSubscriptionId: subscriptionId,
          subscriptionId,
          ...(billingAttemptId ? { billingAttemptId } : {}),
        },
      });
    }

    // IMPORTANT: only downgrade/clear billing state if this webhook refers to the tenant's
    // currently tracked subscription. Older/historical subscriptions can still emit
    // cancellation/completion events (especially if the tenant created a newer autopay).
    try {
      const currentSnap = await billingRef.get();
      const current = currentSnap.exists ? (currentSnap.data() ?? {}) : {};
      const currentProvider = typeof (current as any).billingProvider === 'string' ? String((current as any).billingProvider).toLowerCase() : '';
      const currentSubId = typeof (current as any).subscriptionId === 'string' ? String((current as any).subscriptionId).trim() : '';

      if (subscriptionId && currentProvider === 'razorpay' && currentSubId && currentSubId !== subscriptionId) {
        // This is not the active subscription anymore; don't touch tenant plan state.
        return { ok: true, provider: 'razorpay' };
      }
    } catch {
      // If we cannot verify the current subscription, be conservative and avoid downgrading.
      return { ok: true, provider: 'razorpay' };
    }

    try {
      await billingRef.set(
        {
          planId: 'free',
          planVariantId: null,
          couponCode: null,
          status: 'canceled',
          billingProvider: 'razorpay',
          subscriptionId: subscriptionId || null,
          renewalDate: null,
          checkoutRequired: false,
          checkoutRequiredProvider: admin.firestore.FieldValue.delete(),
          checkoutRequiredSinceIso: admin.firestore.FieldValue.delete(),
          cancelAtCycleEnd: admin.firestore.FieldValue.delete(),
          scheduledDowngradePlanId: admin.firestore.FieldValue.delete(),
          scheduledDowngradeAt: admin.firestore.FieldValue.delete(),
          limitsSnapshot: admin.firestore.FieldValue.delete(),
          limitsSnapshotAt: admin.firestore.FieldValue.delete(),
          delinquentSince: admin.firestore.FieldValue.delete(),
          delinquentSinceIso: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch (error) {
      inc('billing_state_write_failures_total', { provider: 'razorpay', event, operation: 'tenantBilling_set' });
      throw error;
    }

    // Keep tenant doc in sync with billing for enforcement/UI.
    try {
      await db.collection('tenants').doc(tenantIdFromNotes).set(
        {
          billingTier: 'free',
          quotas: admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    } catch {
      inc('billing_state_write_failures_total', { provider: 'razorpay', event, operation: 'tenants_billingTier_set' });
      // ignore
    }

    // If a system job initiated the cancel, suppress the webhook's generic cancellation notice/email.
    // The job itself sends a reasoned notification (e.g., no payment within N hours).
    try {
      const postSnap = await billingRef.get();
      const post = postSnap.exists ? (postSnap.data() ?? {}) : {};
      const ctx = (post as any).lastSystemCancelContext as any;
      const ctxSource = typeof ctx?.source === 'string' ? String(ctx.source) : '';
      const ctxSubId = typeof ctx?.subscriptionId === 'string' ? String(ctx.subscriptionId) : '';
      const matchesSub = !subscriptionId || !ctxSubId || ctxSubId === subscriptionId;
      if (ctxSource === 'billing_stale_pending_job' && matchesSub) {
        try {
          await billingRef.set(
            {
              suppressProviderCancelNotificationUntilIso: admin.firestore.FieldValue.delete(),
              lastSystemCancelContext: admin.firestore.FieldValue.delete(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
        } catch {
          // ignore
        }
        return { ok: true, provider: 'razorpay' };
      }
    } catch {
      // ignore
    }

    void sendTenantBillingEventNotification({
      tenantId: tenantIdFromNotes,
      tenantName: undefined,
      kind: 'subscription_cancelled',
      title: 'Subscription cancelled',
      body: 'Your subscription has ended and the plan is now Free.',
      priority: 'medium',
      dedupeKey: `razorpay_webhook_subscription_cancelled:${subscriptionId || 'unknown'}:${event}`,
      metadata: {
        provider: 'razorpay',
        subscriptionId: subscriptionId || null,
        rawEvent: event,
        // Cancellation webhooks do not reliably indicate who initiated the cancel.
        // Avoid showing misleading "Made by" attribution.
      },
    }).catch(() => undefined);
    return { ok: true, provider: 'razorpay' };
  }

  // Default: accept + record idempotency, no state change.
  void rawBody;
  return { ok: true, provider: 'razorpay' };
  } catch (error) {
    processingOutcome = 'error';
    throw error;
  } finally {
    try {
      await webhookEventRef.set(
        stripUndefinedDeep({
          webhookEventId,
          processedAt: admin.firestore.FieldValue.serverTimestamp(),
          processedAtIso: new Date().toISOString(),
          processingOutcome,
          processingStartedIso,
          tenantId: tenantIdFromNotes,
          event,
          subscriptionId: subscriptionId || null,
          paymentId: paymentId || null,
        }),
        { merge: true }
      );
    } catch {
      // ignore
    }
  }
}
