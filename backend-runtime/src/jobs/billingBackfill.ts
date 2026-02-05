import fetch from 'node-fetch';
import * as admin from 'firebase-admin';
import type { PlanId } from '../lib/planLimits';
import { resolvePlanLimitsFromCatalog, toTenantBillingLimitsSnapshot } from '../lib/effectivePlanLimits';
import { stripUndefinedDeep } from '../lib/stripUndefinedDeep';

function getEnv(name: string): string {
  return (process.env[name] || '').trim();
}

function getBasicAuthHeader(keyId: string, keySecret: string): string {
  const token = Buffer.from(`${keyId}:${keySecret}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

function normalizePlanId(value: unknown): PlanId {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'free' || raw === 'pro' || raw === 'enterprise') {
    return raw;
  }
  return 'free';
}

function toIsoFromUnixSeconds(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  try {
    return new Date(value * 1000).toISOString();
  } catch {
    return null;
  }
}

type RazorpaySubscriptionEntity = {
  id?: string;
  status?: string;
  current_start?: number;
  current_end?: number;
  charge_at?: number;
  start_at?: number;
  ended_at?: number;
  cancelled_at?: number;
  notes?: Record<string, unknown>;
};

type RazorpayPaymentEntity = {
  id?: string;
  status?: string;
  captured?: boolean;
  amount?: number;
  currency?: string;
  method?: string;
  email?: string;
  contact?: string;
  created_at?: number;
  captured_at?: number;
  authorized_at?: number;
  error_code?: string;
  error_description?: string;
  card?: { last4?: string; network?: string };
  upi?: { vpa?: string };
};

type RazorpayInvoiceEntity = {
  id?: string;
  status?: string;
  payment_id?: string;
};

type RazorpayCollection<T> = {
  entity?: string;
  count?: number;
  items?: T[];
};

export type BillingBackfillOptions = {
  tenantIds?: string[];
  maxTenants?: number;
  maxPaymentsPerSubscription?: number;
  dryRun: boolean;
  verbose: boolean;
  jobLabel: string;
  runnerId: string;
};

export type BillingBackfillStats = {
  runId: string;
  jobLabel: string;
  runnerId: string;
  dryRun: boolean;
  startedAtIso: string;
  finishedAtIso?: string;
  tenantsTargeted: number;
  tenantsProcessed: number;
  tenantsSkipped: number;
  subscriptionsFetched: number;
  paymentsFetched: number;
  invoicesUpserted: number;
  invoicesPatched: number;
  billingDocsUpdated: number;
  tenantDocsUpdated: number;
  reconciliation: {
    scope: 'fetched_payments_only';
    maxPaymentsPerSubscription: number;
    providerCapturedPayments: number;
    firestorePaidInvoices: number;
    missingPaidInvoices: number;
    extraPaidInvoices: number;
    missingSamples: Array<{
      tenantId: string;
      subscriptionId: string;
      paymentId: string;
      amountInr: number | null;
      issuedAt: string | null;
    }>;
    extraSamples: Array<{
      tenantId: string;
      subscriptionId: string;
      paymentId: string;
      status: string | null;
      issuedAt: string | null;
    }>;
  };
  reconciliationTenantsPreview: Array<{
    tenantId: string;
    subscriptionId: string;
    providerCapturedPayments: number;
    firestorePaidInvoices: number;
    missingPaidInvoices: number;
    extraPaidInvoices: number;
    missingSamplePaymentIds: string[];
    extraSamplePaymentIds: string[];
  }>;
  errors: Array<{ tenantId: string; code: string; message: string }>;
};

function chunk<T>(items: T[], size: number): T[][] {
  const n = Math.max(1, Math.trunc(size));
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += n) {
    result.push(items.slice(i, i + n));
  }
  return result;
}

async function listFirestoreInvoicesByProviderPaymentIds(options: {
  db: admin.firestore.Firestore;
  tenantId: string;
  paymentIds: string[];
}): Promise<Array<{ id: string; status: string | null; providerPaymentId: string | null; issuedAt: string | null }>> {
  const tenantId = (options.tenantId || '').trim();
  const ids = (options.paymentIds || []).map((id) => (id || '').trim()).filter(Boolean);
  if (!tenantId || !ids.length) return [];

  const invoicesCol = options.db.collection('billingInvoices').doc(tenantId).collection('invoices');
  const results: Array<{ id: string; status: string | null; providerPaymentId: string | null; issuedAt: string | null }> = [];

  // Firestore `in` queries support up to 30 values.
  const batches = chunk(ids, 30);
  for (const batch of batches) {
    try {
      const snap = await invoicesCol.where('providerPaymentId', 'in', batch).get();
      for (const doc of snap.docs) {
        const data = doc.data() || {};
        results.push({
          id: doc.id,
          status: typeof (data as any).status === 'string' ? (data as any).status : null,
          providerPaymentId:
            typeof (data as any).providerPaymentId === 'string' ? (data as any).providerPaymentId : null,
          issuedAt: typeof (data as any).issuedAt === 'string' ? (data as any).issuedAt : null,
        });
      }
    } catch {
      // ignore; reconciliation is best-effort
    }
  }

  return results;
}

function log(prefix: string, message: string, extra?: Record<string, unknown>): void {
  if (extra) {
    console.log(`${prefix} ${message}`, extra);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

async function fetchRazorpaySubscription(subscriptionId: string): Promise<RazorpaySubscriptionEntity> {
  const keyId = getEnv('RAZORPAY_KEY_ID');
  const keySecret = getEnv('RAZORPAY_KEY_SECRET');
  if (!keyId || !keySecret) {
    throw new Error('razorpay_missing_credentials');
  }

  const response = await fetch(`https://api.razorpay.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    method: 'GET',
    headers: {
      Authorization: getBasicAuthHeader(keyId, keySecret),
      'Content-Type': 'application/json',
    },
  });

  const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const message =
      typeof (raw as any)?.error?.description === 'string'
        ? (raw as any).error.description
        : `Razorpay subscription fetch failed (${response.status})`;
    const error = new Error(message);
    (error as any).status = response.status;
    (error as any).providerPayload = raw;
    throw error;
  }

  return raw as RazorpaySubscriptionEntity;
}

async function listRazorpayPaymentsForSubscription(options: {
  subscriptionId: string;
  max: number;
}): Promise<RazorpayPaymentEntity[]> {
  const keyId = getEnv('RAZORPAY_KEY_ID');
  const keySecret = getEnv('RAZORPAY_KEY_SECRET');
  if (!keyId || !keySecret) {
    throw new Error('razorpay_missing_credentials');
  }

  async function fetchRazorpayPayment(paymentId: string): Promise<RazorpayPaymentEntity> {
    const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: 'GET',
      headers: {
        Authorization: getBasicAuthHeader(keyId, keySecret),
        'Content-Type': 'application/json',
      },
    });

    const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message =
        typeof (raw as any)?.error?.description === 'string'
          ? (raw as any).error.description
          : `Razorpay payment fetch failed (${response.status})`;
      const error = new Error(message);
      (error as any).status = response.status;
      (error as any).providerPayload = raw;
      throw error;
    }

    return raw as RazorpayPaymentEntity;
  }

  const subscriptionId = options.subscriptionId.trim();
  const max = Math.max(1, Math.min(500, Math.trunc(options.max)));
  const pageSize = Math.max(1, Math.min(100, max));

  const paymentIds: string[] = [];
  const seenPaymentIds = new Set<string>();
  let skip = 0;

  // Razorpay doesn't support listing payments by subscription directly.
  // We list invoices for the subscription and then fetch each invoice's payment.
  while (paymentIds.length < max) {
    const url = new URL(`https://api.razorpay.com/v1/invoices`);
    url.searchParams.set('subscription_id', subscriptionId);
    url.searchParams.set('count', String(pageSize));
    url.searchParams.set('skip', String(skip));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: getBasicAuthHeader(keyId, keySecret),
        'Content-Type': 'application/json',
      },
    });

    const raw = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message =
        typeof (raw as any)?.error?.description === 'string'
          ? (raw as any).error.description
          : `Razorpay invoices list failed (${response.status})`;
      const error = new Error(message);
      (error as any).status = response.status;
      (error as any).providerPayload = raw;
      throw error;
    }

    const collection = raw as RazorpayCollection<RazorpayInvoiceEntity>;
    const pageItems = Array.isArray(collection.items) ? collection.items : [];
    if (!pageItems.length) {
      break;
    }

    for (const entry of pageItems) {
      if (paymentIds.length >= max) break;
      const paymentId = typeof entry?.payment_id === 'string' ? entry.payment_id.trim() : '';
      if (!paymentId) continue;
      if (seenPaymentIds.has(paymentId)) continue;
      seenPaymentIds.add(paymentId);
      paymentIds.push(paymentId);
    }

    skip += pageItems.length;
    if (pageItems.length < pageSize) {
      break;
    }
  }

  const payments: RazorpayPaymentEntity[] = [];
  for (const paymentId of paymentIds) {
    payments.push(await fetchRazorpayPayment(paymentId));
  }
  return payments;
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

async function resolveInvoiceRefForPayment(options: {
  db: admin.firestore.Firestore;
  tenantId: string;
  paymentId: string;
  subscriptionId?: string;
}) {
  const invoicesCol = options.db.collection('billingInvoices').doc(options.tenantId).collection('invoices');

  // Strong idempotency: if we already have an invoice doc for this payment, always reuse it.
  // This prevents the backfill from generating duplicate invoice docs (and later duplicate invoice
  // numbers/PDFs) for the same Razorpay paymentId.
  try {
    const directRef = invoicesCol.doc(options.paymentId);
    const directSnap = await directRef.get();
    if (directSnap.exists) {
      return directRef;
    }
  } catch {
    // ignore
  }

  // Next-best: find any invoice already linked to this providerPaymentId.
  try {
    const snap = await invoicesCol.where('providerPaymentId', '==', options.paymentId).limit(1).get();
    if (!snap.empty) {
      return snap.docs[0].ref;
    }
  } catch {
    // ignore and fall back
  }

  const normalizedSubscriptionId = (options.subscriptionId || '').trim();
  if (!normalizedSubscriptionId) {
    return invoicesCol.doc(options.paymentId);
  }

  // Prefer updating an existing invoice for this subscription to avoid duplicates.
  // IMPORTANT: avoid composite indexes by filtering in-memory.
  try {
    const snap = await invoicesCol.where('providerSubscriptionId', '==', normalizedSubscriptionId).limit(25).get();
    if (!snap.empty) {
      const byPaymentId = snap.docs.find((doc) => {
        const data = doc.data() || {};
        const pid = typeof (data as any).providerPaymentId === 'string' ? (data as any).providerPaymentId : null;
        return pid === options.paymentId;
      });
      if (byPaymentId) return byPaymentId.ref;

      const open = snap.docs.find((doc) => {
        const data = doc.data() || {};
        return (data as any).status === 'open';
      });
      if (open) return open.ref;
    }
  } catch {
    // ignore and fall back
  }

  return invoicesCol.doc(options.paymentId);
}

async function updateOpenInvoicesForSubscription(options: {
  db: admin.firestore.Firestore;
  tenantId: string;
  subscriptionId: string;
  patch: Record<string, unknown>;
  limit?: number;
}): Promise<number> {
  const tenantId = (options.tenantId || '').trim();
  const subscriptionId = (options.subscriptionId || '').trim();
  if (!tenantId || !subscriptionId) return 0;

  const invoicesCol = options.db.collection('billingInvoices').doc(tenantId).collection('invoices');
  const max = Math.max(1, Math.min(25, Math.trunc(options.limit ?? 10)));

  try {
    const snap = await invoicesCol.where('providerSubscriptionId', '==', subscriptionId).limit(max).get();
    if (snap.empty) return 0;

    const openDocs = snap.docs.filter((doc) => {
      const data = doc.data() || {};
      return (data as any).status === 'open';
    });

    if (!openDocs.length) return 0;

    await Promise.allSettled(openDocs.map((doc) => doc.ref.set(options.patch, { merge: true })));
    return openDocs.length;
  } catch {
    return 0;
  }
}

function inferInvoiceStatus(payment: RazorpayPaymentEntity): 'paid' | 'failed' | 'open' {
  const status = typeof payment.status === 'string' ? payment.status.trim().toLowerCase() : '';
  if (payment.captured === true || status === 'captured') return 'paid';
  if (status === 'failed') return 'failed';
  return 'open';
}

function normalizeSubscriptionStatus(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return raw || null;
}

function desiredBillingStatusFromSubscriptionStatus(status: string | null): 'active' | 'delinquent' | 'canceled' {
  if (!status) return 'delinquent';
  if (status === 'active' || status === 'authenticated') return 'active';
  if (status === 'cancelled' || status === 'completed' || status === 'expired') return 'canceled';
  if (status === 'halted' || status === 'failed' || status === 'pending') return 'delinquent';
  return 'delinquent';
}

function getRunnerDefault(): string {
  return (
    getEnv('BILLING_BACKFILL_RUNNER_ID') ||
    getEnv('GITHUB_SHA') ||
    getEnv('USER') ||
    getEnv('USERNAME') ||
    'unknown'
  );
}

async function loadTargetTenantIds(db: admin.firestore.Firestore, options: BillingBackfillOptions): Promise<string[]> {
  const explicit = (options.tenantIds || []).map((id) => id.trim()).filter(Boolean);
  if (explicit.length) {
    return explicit;
  }

  const max = Math.max(1, Math.min(500, Math.trunc(options.maxTenants ?? 250)));
  const snap = await db.collection('tenantBilling').where('billingProvider', '==', 'razorpay').limit(max).get();
  return snap.docs.map((doc) => doc.id);
}

export async function runBillingBackfill(db: admin.firestore.Firestore, options: Partial<BillingBackfillOptions> = {}) {
  const startedAtIso = new Date().toISOString();
  const runId = `${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const effective: BillingBackfillOptions = {
    tenantIds: options.tenantIds,
    maxTenants: options.maxTenants,
    maxPaymentsPerSubscription: options.maxPaymentsPerSubscription,
    dryRun: options.dryRun === true,
    verbose: options.verbose === true,
    jobLabel: (options.jobLabel || '').trim() || 'billing_backfill',
    runnerId: (options.runnerId || '').trim() || getRunnerDefault(),
  };

  const prefix = `[billing_backfill:${effective.jobLabel}]`;

  const stats: BillingBackfillStats = {
    runId,
    jobLabel: effective.jobLabel,
    runnerId: effective.runnerId,
    dryRun: effective.dryRun,
    startedAtIso,
    tenantsTargeted: 0,
    tenantsProcessed: 0,
    tenantsSkipped: 0,
    subscriptionsFetched: 0,
    paymentsFetched: 0,
    invoicesUpserted: 0,
    invoicesPatched: 0,
    billingDocsUpdated: 0,
    tenantDocsUpdated: 0,
    reconciliation: {
      scope: 'fetched_payments_only',
      maxPaymentsPerSubscription: Math.max(1, Math.min(500, Math.trunc(effective.maxPaymentsPerSubscription ?? 200))),
      providerCapturedPayments: 0,
      firestorePaidInvoices: 0,
      missingPaidInvoices: 0,
      extraPaidInvoices: 0,
      missingSamples: [],
      extraSamples: [],
    },
    reconciliationTenantsPreview: [],
    errors: [],
  };

  const runRef = db.collection('billingBackfillRuns').doc(runId);
  if (!effective.dryRun) {
    await runRef.set(
      stripUndefinedDeep({
        runId,
        jobLabel: effective.jobLabel,
        runnerId: effective.runnerId,
        dryRun: effective.dryRun,
        startedAtIso,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'running',
      }),
      { merge: true }
    );
  }

  const targetTenantIds = await loadTargetTenantIds(db, effective);
  stats.tenantsTargeted = targetTenantIds.length;

  log(prefix, 'job started', {
    runId,
    dryRun: effective.dryRun,
    tenantsTargeted: stats.tenantsTargeted,
    maxPaymentsPerSubscription: effective.maxPaymentsPerSubscription ?? 200,
  });

  for (const tenantId of targetTenantIds) {
    const normalizedTenantId = (tenantId || '').trim();
    if (!normalizedTenantId) {
      stats.tenantsSkipped += 1;
      continue;
    }

    try {
      const billingRef = db.collection('tenantBilling').doc(normalizedTenantId);
      const billingSnap = await billingRef.get();
      const billingData = billingSnap.exists ? billingSnap.data() || {} : {};

      const subscriptionId =
        typeof (billingData as any).subscriptionId === 'string' && (billingData as any).subscriptionId.trim()
          ? (billingData as any).subscriptionId.trim()
          : '';

      if (!subscriptionId) {
        stats.tenantsSkipped += 1;
        continue;
      }

      const subscription = await fetchRazorpaySubscription(subscriptionId);
      stats.subscriptionsFetched += 1;

      const subscriptionStatus = normalizeSubscriptionStatus(subscription.status);
      const desiredStatus = desiredBillingStatusFromSubscriptionStatus(subscriptionStatus);

      const notes = (subscription.notes && typeof subscription.notes === 'object' ? subscription.notes : {}) as Record<
        string,
        unknown
      >;
      const planIdFromNotes = normalizePlanId(notes.planId);
      const planVariantIdFromNotes = typeof notes.planVariantId === 'string' ? notes.planVariantId.trim() : '';
      const couponCodeFromNotes = typeof notes.couponCode === 'string' ? notes.couponCode.trim() : '';

      const renewalDate = toIsoFromUnixSeconds(subscription.current_end);

      const maxPayments = Math.max(1, Math.min(500, Math.trunc(effective.maxPaymentsPerSubscription ?? 200)));
      const payments = await listRazorpayPaymentsForSubscription({ subscriptionId, max: maxPayments });
      stats.paymentsFetched += payments.length;

      if (effective.verbose) {
        log(prefix, 'tenant loaded', {
          tenantId: normalizedTenantId,
          subscriptionId,
          subscriptionStatus,
          desiredStatus,
          payments: payments.length,
          planIdFromNotes,
          planVariantIdFromNotes: planVariantIdFromNotes || null,
        });
      }

      // Upsert invoices from provider payment list
      const paymentIdToEntity = new Map<string, RazorpayPaymentEntity>();
      const providerCapturedPaymentIds = new Set<string>();
      const providerAllPaymentIds: string[] = [];

      for (const payment of payments) {
        const paymentId = typeof payment.id === 'string' ? payment.id : '';
        if (!paymentId) continue;

        paymentIdToEntity.set(paymentId, payment);
        providerAllPaymentIds.push(paymentId);

        const invoiceStatus = inferInvoiceStatus(payment);
        if (invoiceStatus === 'paid') {
          providerCapturedPaymentIds.add(paymentId);
        }
        const amountPaise = typeof payment.amount === 'number' ? payment.amount : 0;
        const amountInr = Math.round(amountPaise / 100);

        const issuedAt = toIsoFromUnixSeconds(payment.created_at) || new Date().toISOString();
        const authorizedAt = toIsoFromUnixSeconds(payment.authorized_at);
        const capturedAt = toIsoFromUnixSeconds(payment.captured_at) || (invoiceStatus === 'paid' ? issuedAt : null);

        const payerEmail = typeof payment.email === 'string' ? payment.email : null;
        const currency = typeof payment.currency === 'string' ? payment.currency : null;
        const method = typeof payment.method === 'string' ? payment.method : null;

        const cardLast4 = typeof payment.card?.last4 === 'string' ? payment.card.last4 : null;
        const cardNetwork = typeof payment.card?.network === 'string' ? payment.card.network : null;
        const upiVpaMasked = maskUpiVpa(payment.upi?.vpa);

        const errorCode = typeof payment.error_code === 'string' ? payment.error_code : null;
        const errorDescription = typeof payment.error_description === 'string' ? payment.error_description : null;

        const targetRef = await resolveInvoiceRefForPayment({
          db,
          tenantId: normalizedTenantId,
          paymentId,
          subscriptionId,
        });

        if (!effective.dryRun) {
          await targetRef.set(
            stripUndefinedDeep({
              amountInr,
              status: invoiceStatus,
              provider: 'razorpay',
              issuedAt,
              isSynthetic: false,
              sourceEvent: 'backfill',
              rawEvent: 'backfill',
              backfillRunId: runId,
              backfilledAtIso: new Date().toISOString(),
              providerPaymentId: paymentId,
              providerSubscriptionId: subscriptionId,
              subscriptionId,
              planId: planIdFromNotes,
              planVariantId: planVariantIdFromNotes || null,
              couponCode: couponCodeFromNotes || null,
              payerEmail,
              currency,
              method,
              cardLast4,
              cardNetwork,
              upiVpaMasked,
              authorizedAt,
              capturedAt,
              errorCode,
              errorDescription,
            }),
            { merge: true }
          );
        }

        stats.invoicesUpserted += 1;
      }

      // Reconciliation report (best-effort): compare provider captured payments vs Firestore paid invoices,
      // scoped to the payment IDs fetched in this run (bounded by maxPaymentsPerSubscription).
      const firestorePaidPaymentIds = new Set<string>();
      if (providerAllPaymentIds.length) {
        const invoiceDocs = await listFirestoreInvoicesByProviderPaymentIds({
          db,
          tenantId: normalizedTenantId,
          paymentIds: providerAllPaymentIds,
        });
        for (const inv of invoiceDocs) {
          if (inv.status === 'paid' && inv.providerPaymentId) {
            firestorePaidPaymentIds.add(inv.providerPaymentId);
          }
        }
      }

      const missing = Array.from(providerCapturedPaymentIds).filter((id) => !firestorePaidPaymentIds.has(id));
      const extra = Array.from(firestorePaidPaymentIds).filter((id) => !providerCapturedPaymentIds.has(id));

      stats.reconciliation.providerCapturedPayments += providerCapturedPaymentIds.size;
      stats.reconciliation.firestorePaidInvoices += firestorePaidPaymentIds.size;
      stats.reconciliation.missingPaidInvoices += missing.length;
      stats.reconciliation.extraPaidInvoices += extra.length;

      const MAX_SAMPLES = 40;
      if ((missing.length || extra.length) && stats.reconciliationTenantsPreview.length < 25) {
        stats.reconciliationTenantsPreview.push({
          tenantId: normalizedTenantId,
          subscriptionId,
          providerCapturedPayments: providerCapturedPaymentIds.size,
          firestorePaidInvoices: firestorePaidPaymentIds.size,
          missingPaidInvoices: missing.length,
          extraPaidInvoices: extra.length,
          missingSamplePaymentIds: missing.slice(0, 3),
          extraSamplePaymentIds: extra.slice(0, 3),
        });
      }

      for (const paymentId of missing) {
        if (stats.reconciliation.missingSamples.length >= MAX_SAMPLES) break;
        const payment = paymentIdToEntity.get(paymentId);
        const amountPaise = typeof payment?.amount === 'number' ? payment.amount : 0;
        const amountInr = Number.isFinite(amountPaise) ? Math.round(amountPaise / 100) : 0;
        const issuedAt = toIsoFromUnixSeconds(payment?.created_at);
        stats.reconciliation.missingSamples.push({
          tenantId: normalizedTenantId,
          subscriptionId,
          paymentId,
          amountInr: Number.isFinite(amountInr) ? amountInr : null,
          issuedAt,
        });
      }

      if (providerAllPaymentIds.length && stats.reconciliation.extraSamples.length < MAX_SAMPLES) {
        const invoiceDocs = await listFirestoreInvoicesByProviderPaymentIds({
          db,
          tenantId: normalizedTenantId,
          paymentIds: extra,
        });
        for (const inv of invoiceDocs) {
          if (stats.reconciliation.extraSamples.length >= MAX_SAMPLES) break;
          stats.reconciliation.extraSamples.push({
            tenantId: normalizedTenantId,
            subscriptionId,
            paymentId: inv.providerPaymentId || inv.id,
            status: inv.status,
            issuedAt: inv.issuedAt,
          });
        }
      }

      // Patch open invoices based on subscription truth (best-effort)
      if (desiredStatus === 'canceled') {
        const patched = await updateOpenInvoicesForSubscription({
          db,
          tenantId: normalizedTenantId,
          subscriptionId,
          patch: stripUndefinedDeep({
            status: 'void',
            sourceEvent: 'backfill_subscription_cancelled',
            rawEvent: 'backfill',
            provider: 'razorpay',
            providerSubscriptionId: subscriptionId,
            subscriptionId,
            planId: 'free',
          }),
        });
        stats.invoicesPatched += patched;
      } else if (desiredStatus === 'delinquent' && (subscriptionStatus === 'halted' || subscriptionStatus === 'failed')) {
        const patched = await updateOpenInvoicesForSubscription({
          db,
          tenantId: normalizedTenantId,
          subscriptionId,
          patch: stripUndefinedDeep({
            status: 'failed',
            sourceEvent: 'backfill_subscription_failed',
            rawEvent: 'backfill',
            provider: 'razorpay',
            providerSubscriptionId: subscriptionId,
            subscriptionId,
            planId: planIdFromNotes,
            planVariantId: planVariantIdFromNotes || null,
            couponCode: couponCodeFromNotes || null,
          }),
        });
        stats.invoicesPatched += patched;
      }

      // Reconcile tenantBilling + tenants billingTier conservatively
      const currentPlanId: PlanId = normalizePlanId((billingData as any).planId);
      const currentPlanVariantId = typeof (billingData as any).planVariantId === 'string' ? (billingData as any).planVariantId.trim() : '';
      const currentCouponCode = typeof (billingData as any).couponCode === 'string' ? (billingData as any).couponCode.trim() : '';
      const currentStatusRaw = typeof (billingData as any).status === 'string' ? (billingData as any).status.trim().toLowerCase() : '';
      const currentStatus =
        currentStatusRaw === 'active' || currentStatusRaw === 'delinquent' || currentStatusRaw === 'canceled' || currentStatusRaw === 'trial'
          ? currentStatusRaw
          : '';
      const planLockedByOrg = (billingData as any).planLockedByOrg === true;

      // Strong signals of a paid activation:
      // - we already considered the tenant on a paid plan previously, OR
      // - we can see at least one captured payment for this subscription.
      const hasCapturedPaymentEvidence = providerCapturedPaymentIds.size > 0;

      let effectiveDesiredStatus = desiredStatus;
      if (planLockedByOrg) {
        if (currentStatus === 'active' || currentStatus === 'trial') {
          effectiveDesiredStatus = 'active';
        } else if (currentStatus === 'canceled') {
          effectiveDesiredStatus = 'canceled';
        } else if (currentStatus === 'delinquent') {
          effectiveDesiredStatus = 'delinquent';
        }
      }
      if (effectiveDesiredStatus === 'delinquent' && currentPlanId === 'free' && !hasCapturedPaymentEvidence) {
        // Common case: user started checkout but never paid; subscription ends up pending/failed/halted.
        // Don't "upgrade" or show paid-plan delinquency for a Free tenant without any captured payment evidence.
        effectiveDesiredStatus = 'canceled';
      }

      const paidPlanCandidate: PlanId = planLockedByOrg
        ? currentPlanId
        : planIdFromNotes !== 'free'
          ? planIdFromNotes
          : currentPlanId;
      if (effectiveDesiredStatus !== 'canceled' && paidPlanCandidate === 'free') {
        // Avoid writing a confusing state like free+delinquent when we can't confidently resolve a paid plan.
        effectiveDesiredStatus = 'canceled';
      }

      const shouldBePlanId: PlanId = effectiveDesiredStatus === 'canceled' ? 'free' : paidPlanCandidate;

      let limitsSnapshot: ReturnType<typeof toTenantBillingLimitsSnapshot> | null = null;
      if (desiredStatus === 'active' && shouldBePlanId !== 'free') {
        try {
          const resolved = await resolvePlanLimitsFromCatalog(db, {
            planId: shouldBePlanId,
            planVariantId: planVariantIdFromNotes || null,
          });
          limitsSnapshot = toTenantBillingLimitsSnapshot(resolved);
        } catch {
          limitsSnapshot = null;
        }
      }

      const nowIso = new Date().toISOString();
      const billingPatch: Record<string, unknown> = {
        planId: shouldBePlanId,
        planVariantId:
          effectiveDesiredStatus === 'canceled'
            ? null
            : (planVariantIdFromNotes || currentPlanVariantId || '').trim() || null,
        couponCode:
          effectiveDesiredStatus === 'canceled' ? null : (couponCodeFromNotes || currentCouponCode || '').trim() || null,
        status: effectiveDesiredStatus,
        billingProvider: 'razorpay',
        subscriptionId,
        ...(effectiveDesiredStatus === 'active' ? { renewalDate: renewalDate } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        backfillRunId: runId,
        backfilledAtIso: nowIso,
      };

      if (effectiveDesiredStatus === 'active') {
        billingPatch.cancelAtCycleEnd = admin.firestore.FieldValue.delete();
        billingPatch.scheduledDowngradePlanId = admin.firestore.FieldValue.delete();
        billingPatch.scheduledDowngradeAt = admin.firestore.FieldValue.delete();
        billingPatch.delinquentSince = admin.firestore.FieldValue.delete();
        billingPatch.delinquentSinceIso = admin.firestore.FieldValue.delete();
        if (limitsSnapshot) {
          billingPatch.limitsSnapshot = limitsSnapshot;
          billingPatch.limitsSnapshotAt = admin.firestore.FieldValue.serverTimestamp();
        }
      } else if (effectiveDesiredStatus === 'canceled') {
        billingPatch.cancelAtCycleEnd = admin.firestore.FieldValue.delete();
        billingPatch.scheduledDowngradePlanId = admin.firestore.FieldValue.delete();
        billingPatch.scheduledDowngradeAt = admin.firestore.FieldValue.delete();
        billingPatch.renewalDate = null;
        billingPatch.limitsSnapshot = admin.firestore.FieldValue.delete();
        billingPatch.limitsSnapshotAt = admin.firestore.FieldValue.delete();
        billingPatch.delinquentSince = admin.firestore.FieldValue.delete();
        billingPatch.delinquentSinceIso = admin.firestore.FieldValue.delete();
      } else {
        // delinquent
        const alreadyDelinquentSince = typeof (billingData as any).delinquentSinceIso === 'string' ? (billingData as any).delinquentSinceIso : null;
        if (!alreadyDelinquentSince) {
          billingPatch.delinquentSince = admin.firestore.FieldValue.serverTimestamp();
          billingPatch.delinquentSinceIso = nowIso;
        }
      }

      if (!effective.dryRun) {
        await billingRef.set(stripUndefinedDeep(billingPatch), { merge: true });
      }
      stats.billingDocsUpdated += 1;

      // Adjust tenants.billingTier only when we have strong signals.
      // - active -> plan
      // - canceled -> free
      // - delinquent -> leave as-is (grace-period behavior uses tenantBilling.status)
      const tenantRef = db.collection('tenants').doc(normalizedTenantId);
      if (!effective.dryRun) {
        await tenantRef.set(
          stripUndefinedDeep({
            ...(effectiveDesiredStatus === 'active' || effectiveDesiredStatus === 'canceled' ? { billingTier: shouldBePlanId } : {}),
            ...(effectiveDesiredStatus === 'canceled' ? { quotas: admin.firestore.FieldValue.delete() } : {}),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            billingBackfillRunId: runId,
            billingBackfilledAtIso: nowIso,
          }),
          { merge: true }
        );
      }
      stats.tenantDocsUpdated += 1;

      stats.tenantsProcessed += 1;
    } catch (error) {
      stats.errors.push({
        tenantId: normalizedTenantId,
        code: 'tenant_backfill_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      stats.tenantsProcessed += 1;

      log(prefix, 'tenant backfill failed', {
        tenantId: normalizedTenantId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  stats.finishedAtIso = new Date().toISOString();

  log(prefix, 'job completed', {
    runId,
    finishedAtIso: stats.finishedAtIso,
    tenantsProcessed: stats.tenantsProcessed,
    errors: stats.errors.length,
    invoicesUpserted: stats.invoicesUpserted,
  });

  if (!effective.dryRun) {
    await runRef.set(
      stripUndefinedDeep({
        finishedAtIso: stats.finishedAtIso,
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: stats.errors.length > 0 ? 'completed_with_errors' : 'completed',
        stats: {
          tenantsTargeted: stats.tenantsTargeted,
          tenantsProcessed: stats.tenantsProcessed,
          tenantsSkipped: stats.tenantsSkipped,
          subscriptionsFetched: stats.subscriptionsFetched,
          paymentsFetched: stats.paymentsFetched,
          invoicesUpserted: stats.invoicesUpserted,
          invoicesPatched: stats.invoicesPatched,
          billingDocsUpdated: stats.billingDocsUpdated,
          tenantDocsUpdated: stats.tenantDocsUpdated,
          errors: stats.errors.length,
          reconciliation: stats.reconciliation,
          reconciliationTenantsPreview: stats.reconciliationTenantsPreview,
        },
        errorsPreview: stats.errors.slice(0, 20),
      }),
      { merge: true }
    );
  }

  return stats;
}
