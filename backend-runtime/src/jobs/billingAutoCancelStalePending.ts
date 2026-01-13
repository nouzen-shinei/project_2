import admin from 'firebase-admin';
import crypto from 'crypto';
import { stripUndefinedDeep } from '../lib/stripUndefinedDeep';
import { cancelRazorpaySubscription } from '../billing/razorpay';
import { sendTenantBillingEventNotification } from '../billing/billingNotifier';

type Firestore = admin.firestore.Firestore;

type AutoCancelOptions = {
  tenantIds?: string[];
  maxTenants?: number;
  thresholdHours: number;
  dryRun: boolean;
  verbose: boolean;
  jobLabel: string;
  tenantLeaseMs?: number;
  runLeaseMs?: number;
};

type TenantCandidate = {
  tenantId: string;
  reason: 'open_invoice' | 'checkout_required';
  sinceIso: string;
  provider?: string;
  subscriptionId?: string;
  billingAttemptId?: string;
};

type AttemptToCancel = {
  provider: string;
  subscriptionId: string;
  billingAttemptId?: string;
  sinceIso: string;
  attemptKey: string;
  invoiceDocs: Array<admin.firestore.QueryDocumentSnapshot>;
};

type Stats = {
  jobLabel: string;
  runId: string;
  dryRun: boolean;
  thresholdHours: number;
  startedAtIso: string;
  finishedAtIso?: string;
  candidatesFound: number;
  tenantsProcessed: number;
  tenantsSkippedLocked: number;
  tenantsSkipped: number;
  tenantsCancelled: number;
  invoicesFailed: number;
  invoicesCreated: number;
  providerCancelsAttempted: number;
  providerCancelsFailed: number;
  fatalError?: { tenantId: string; message: string };
  errors: Array<{ tenantId: string; message: string }>;
};

function log(verbose: boolean, message: string, extra?: Record<string, unknown>): void {
  if (!verbose) return;
  if (extra) console.log(`[billing_stale_pending] ${message}`, extra);
  else console.log(`[billing_stale_pending] ${message}`);
}

function parseIso(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function isoOlderThan(iso: string, cutoffMs: number): boolean {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms <= cutoffMs;
}

function addHoursIso(iso: string, hours: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms + hours * 60 * 60 * 1000).toISOString();
}

function computeAttemptKey(input: { attemptId?: string; provider: string; subscriptionId: string; sinceIso: string }): string {
  const attemptId = (input.attemptId || '').trim();
  if (attemptId) return `attempt:${attemptId}`;
  const provider = (input.provider || '').trim().toLowerCase() || 'unknown';
  const subscriptionId = (input.subscriptionId || '').trim() || 'unknown';
  const sinceIso = (input.sinceIso || '').trim() || 'unknown';
  return `${provider}:${subscriptionId}:${sinceIso}`;
}

function computeSyntheticFailedInvoiceDocId(stableKey: string): string {
  const key = (stableKey || '').trim() || 'unknown';
  return `auto_failed_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

async function acquireTenantLease(options: {
  db: Firestore;
  tenantId: string;
  leaseMs: number;
  jobLabel: string;
  runId: string;
}): Promise<null | { token: string; release: () => Promise<void> }> {
  const { db, tenantId, leaseMs, jobLabel, runId } = options;
  const effectiveLeaseMs = Math.max(30_000, Math.min(30 * 60_000, Math.trunc(leaseMs || 0) || 180_000));
  const ref = db.collection('jobLeases').doc(`billing_stale_pending_${tenantId}`);
  const token = crypto.randomUUID();

  const acquired = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const nowMs = Date.now();
    const data = snap.exists ? (snap.data() ?? {}) : {};
    const expiresAtMs = typeof (data as any).expiresAtMs === 'number' ? (data as any).expiresAtMs : 0;
    if (expiresAtMs && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs) {
      return false;
    }
    tx.set(
      ref,
      {
        jobName: 'billing_stale_pending',
        jobLabel,
        runId,
        tenantId,
        token,
        acquiredAtIso: new Date(nowMs).toISOString(),
        expiresAtMs: nowMs + effectiveLeaseMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  });

  if (!acquired) return null;

  const release = async (): Promise<void> => {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data() ?? {};
      if (typeof (data as any).token === 'string' && (data as any).token === token) {
        tx.delete(ref);
      }
    });
  };

  return { token, release };
}

async function acquireRunLease(options: {
  db: Firestore;
  leaseMs: number;
  jobLabel: string;
  runId: string;
}): Promise<null | { token: string; release: () => Promise<void> }> {
  const { db, leaseMs, jobLabel, runId } = options;
  // Clamp to 5m..6h; default 2h.
  const effectiveLeaseMs = Math.max(5 * 60_000, Math.min(6 * 60 * 60_000, Math.trunc(leaseMs || 0) || 2 * 60 * 60_000));
  const ref = db.collection('jobLeases').doc(`billing_stale_pending_run_${jobLabel || 'billing_stale_pending'}`);
  const token = crypto.randomUUID();

  const acquired = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const nowMs = Date.now();
    const data = snap.exists ? (snap.data() ?? {}) : {};
    const expiresAtMs = typeof (data as any).expiresAtMs === 'number' ? (data as any).expiresAtMs : 0;
    if (expiresAtMs && Number.isFinite(expiresAtMs) && expiresAtMs > nowMs) {
      return false;
    }
    tx.set(
      ref,
      {
        jobName: 'billing_stale_pending_run',
        jobLabel,
        runId,
        token,
        acquiredAtIso: new Date(nowMs).toISOString(),
        expiresAtMs: nowMs + effectiveLeaseMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return true;
  });

  if (!acquired) return null;

  const release = async (): Promise<void> => {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const data = snap.data() ?? {};
      if (typeof (data as any).token === 'string' && (data as any).token === token) {
        tx.delete(ref);
      }
    });
  };

  return { token, release };
}

type GooglePlayServiceAccount = { client_email: string; private_key: string };

function parseGooglePlayServiceAccountFromEnv(): GooglePlayServiceAccount {
  const raw = (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) {
    throw new Error('google_play_unconfigured');
  }

  const parseJson = (text: string): GooglePlayServiceAccount => {
    const parsed = JSON.parse(text) as any;
    const email = typeof parsed?.client_email === 'string' ? parsed.client_email.trim() : '';
    const key = typeof parsed?.private_key === 'string' ? parsed.private_key : '';
    if (!email || !key) {
      throw new Error('google_play_invalid_service_account');
    }
    return { client_email: email, private_key: key };
  };

  if (raw.startsWith('{')) {
    return parseJson(raw);
  }

  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.trim().startsWith('{')) {
      return parseJson(decoded);
    }
  } catch {
    // ignore
  }

  return parseJson(raw);
}

type CachedGooglePlayToken = { accessToken: string; expiresAtMs: number };
let cachedGooglePlayToken: CachedGooglePlayToken | null = null;

async function getGooglePlayAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedGooglePlayToken && cachedGooglePlayToken.expiresAtMs - now > 30_000) {
    return cachedGooglePlayToken.accessToken;
  }

  const { JWT } = await import('google-auth-library');
  const sa = parseGooglePlayServiceAccountFromEnv();
  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ['https://www.googleapis.com/auth/androidpublisher'],
  });

  const auth = await client.authorize();
  const token = typeof (auth as any)?.access_token === 'string' ? String((auth as any).access_token) : '';
  if (!token) {
    throw new Error('google_play_token_failed');
  }
  const expiry = typeof (auth as any)?.expiry_date === 'number' && Number.isFinite((auth as any).expiry_date)
    ? (auth as any).expiry_date
    : now + 50 * 60_000;
  cachedGooglePlayToken = { accessToken: token, expiresAtMs: expiry };
  return token;
}

async function cancelGooglePlaySubscription(options: {
  packageName: string;
  productId: string;
  purchaseToken: string;
}): Promise<void> {
  const accessToken = await getGooglePlayAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(options.packageName)}` +
    `/purchases/subscriptions/${encodeURIComponent(options.productId)}/tokens/${encodeURIComponent(options.purchaseToken)}:cancel`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (resp.ok) {
    return;
  }

  const text = await resp.text().catch(() => '');
  const err = new Error(text || `google_play_cancel_failed_${resp.status}`);
  (err as any).status = resp.status;
  throw err;
}

async function hasAnyPaidInvoice(db: Firestore, tenantId: string): Promise<boolean> {
  const snap = await db
    .collection('billingInvoices')
    .doc(tenantId)
    .collection('invoices')
    .where('status', '==', 'paid')
    .limit(1)
    .get();
  return !snap.empty;
}

async function hasPaidInvoiceForAttempt(options: {
  db: Firestore;
  tenantId: string;
  sinceIso: string;
  attemptId?: string;
  provider?: string;
  subscriptionId?: string;
}): Promise<boolean> {
  const { db, tenantId } = options;
  const sinceMs = Date.parse(options.sinceIso);
  if (!Number.isFinite(sinceMs)) {
    // Fall back to historical behavior if sinceIso is invalid.
    return hasAnyPaidInvoice(db, tenantId);
  }

  const provider = (options.provider || '').trim().toLowerCase();
  const subscriptionId = (options.subscriptionId || '').trim();
  const attemptId = (options.attemptId || '').trim();

  // Avoid extra composite index requirements by reading a small window of recent paid invoices
  // and filtering in memory.
  const snap = await db
    .collection('billingInvoices')
    .doc(tenantId)
    .collection('invoices')
    .where('status', '==', 'paid')
    .orderBy('issuedAt', 'desc')
    .limit(50)
    .get();

  if (snap.empty) return false;

  for (const doc of snap.docs) {
    const data = doc.data() as any;
    const issuedAtIso = parseIso(data?.issuedAt);
    if (!issuedAtIso) {
      continue;
    }
    const issuedAtMs = Date.parse(issuedAtIso);
    if (!Number.isFinite(issuedAtMs)) {
      continue;
    }
    if (issuedAtMs < sinceMs) {
      // Since the query is ordered desc by issuedAt, we can stop early.
      break;
    }

    const invoiceProvider = typeof data?.provider === 'string' ? String(data.provider).trim().toLowerCase() : '';
    const invoiceSubscriptionId = typeof data?.subscriptionId === 'string' ? String(data.subscriptionId).trim() : '';
    const invoiceProviderSubscriptionId = typeof data?.providerSubscriptionId === 'string' ? String(data.providerSubscriptionId).trim() : '';
    const invoiceAttemptId = typeof data?.billingAttemptId === 'string' ? String(data.billingAttemptId).trim() : '';

    if (attemptId) {
      if (invoiceAttemptId && invoiceAttemptId === attemptId) {
        return true;
      }
      // attemptId is present but invoice is not stamped; fall back to provider/subscription matching.
    }

    if (provider && invoiceProvider && provider !== invoiceProvider) {
      continue;
    }
    if (subscriptionId) {
      if (invoiceSubscriptionId === subscriptionId || invoiceProviderSubscriptionId === subscriptionId) {
        return true;
      }
      continue;
    }

    // If we don't have a subscription id, any paid invoice since sinceIso counts as paid for this attempt.
    return true;
  }

  return false;
}

async function failOpenInvoicesForTenant(options: {
  db: Firestore;
  tenantId: string;
  nowIso: string;
  reasonCode: string;
  reasonDescription: string;
  attemptKey?: string;
  billingAttemptId?: string;
  provider?: string;
  subscriptionId?: string;
  sinceIso?: string;
  dryRun: boolean;
}): Promise<number> {
  const { db, tenantId, nowIso, reasonCode, reasonDescription, attemptKey, billingAttemptId, provider, subscriptionId, sinceIso, dryRun } = options;
  const snap = await db
    .collection('billingInvoices')
    .doc(tenantId)
    .collection('invoices')
    .where('status', '==', 'open')
    .limit(250)
    .get();
  if (snap.empty) return 0;

  const targetProvider = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
  const targetSubscriptionId = typeof subscriptionId === 'string' ? subscriptionId.trim() : '';
  const targetAttemptId = typeof billingAttemptId === 'string' ? billingAttemptId.trim() : '';
  const targetSinceMs = typeof sinceIso === 'string' ? Date.parse(sinceIso) : NaN;

  const matchesAttempt = (data: any): boolean => {
    const invoiceProvider = typeof data?.provider === 'string' ? String(data.provider).trim().toLowerCase() : '';
    const invoiceSubscriptionId = typeof data?.subscriptionId === 'string' ? String(data.subscriptionId).trim() : '';
    const invoiceProviderSubscriptionId = typeof data?.providerSubscriptionId === 'string' ? String(data.providerSubscriptionId).trim() : '';
    const invoiceAttemptId = typeof data?.billingAttemptId === 'string' ? String(data.billingAttemptId).trim() : '';
    const issuedAtIso = parseIso(data?.issuedAt);
    const issuedAtMs = issuedAtIso ? Date.parse(issuedAtIso) : NaN;

    if (targetAttemptId && invoiceAttemptId) {
      return invoiceAttemptId === targetAttemptId;
    }

    if (targetProvider && invoiceProvider && targetProvider !== invoiceProvider) {
      return false;
    }

    if (targetSubscriptionId) {
      const hasStamp = Boolean(invoiceSubscriptionId || invoiceProviderSubscriptionId || invoiceAttemptId);
      if (hasStamp) {
        return invoiceSubscriptionId === targetSubscriptionId || invoiceProviderSubscriptionId === targetSubscriptionId;
      }

      // Some invoice writers historically didn't stamp providerSubscriptionId/subscriptionId.
      // In that case, we cannot reliably scope by subscriptionId, so fail the open invoice
      // (leaving it open is worse/incorrect once the tenant is downgraded).
      return true;
    }

    if (Number.isFinite(targetSinceMs) && Number.isFinite(issuedAtMs)) {
      return issuedAtMs >= targetSinceMs;
    }

    // If we don't have enough info to scope, match everything (historical behavior).
    return true;
  };

  const matchedDocs = snap.docs.filter((d) => matchesAttempt(d.data() as any));
  if (matchedDocs.length === 0) return 0;

  if (dryRun) {
    return matchedDocs.length;
  }

  const batch = db.batch();
  for (const doc of matchedDocs) {
    batch.set(
      doc.ref,
      stripUndefinedDeep({
        status: 'failed',
        failedAt: nowIso,
        errorCode: reasonCode,
        errorDescription: reasonDescription,
        sourceEvent: 'auto_cancel_no_payment_24h',
        rawEvent: 'auto_cancel',
        autoCancelAttemptKey: attemptKey || null,
        ...(billingAttemptId ? { billingAttemptId } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      { merge: true }
    );
  }
  await batch.commit();
  return matchedDocs.length;
}

async function failInvoicesByDocs(options: {
  db: Firestore;
  docs: Array<admin.firestore.QueryDocumentSnapshot>;
  nowIso: string;
  reasonCode: string;
  reasonDescription: string;
  attemptKey?: string;
  billingAttemptId?: string;
  dryRun: boolean;
}): Promise<number> {
  const { db, docs, nowIso, reasonCode, reasonDescription, attemptKey, billingAttemptId, dryRun } = options;
  if (!docs.length) return 0;
  if (dryRun) return docs.length;

  const batch = db.batch();
  for (const doc of docs) {
    batch.set(
      doc.ref,
      stripUndefinedDeep({
        status: 'failed',
        failedAt: nowIso,
        errorCode: reasonCode,
        errorDescription: reasonDescription,
        sourceEvent: 'auto_cancel_no_payment_24h',
        rawEvent: 'auto_cancel',
        autoCancelAttemptKey: attemptKey || null,
        ...(billingAttemptId ? { billingAttemptId } : {}),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }),
      { merge: true }
    );
  }
  await batch.commit();
  return docs.length;
}

async function createFailedInvoiceIfMissing(options: {
  db: Firestore;
  tenantId: string;
  nowIso: string;
  sinceIso: string;
  provider?: string;
  providerSubscriptionId?: string;
  subscriptionId?: string;
  planId?: string;
  planVariantId?: string | null;
  attemptKey?: string;
  billingAttemptId?: string;
  reasonCode: string;
  reasonDescription: string;
  dryRun: boolean;
}): Promise<boolean> {
  const {
    db,
    tenantId,
    nowIso,
    sinceIso,
    provider,
    providerSubscriptionId,
    subscriptionId,
    planId,
    planVariantId,
    attemptKey,
    billingAttemptId,
    reasonCode,
    reasonDescription,
    dryRun,
  } = options;

  const stableKey =
    attemptKey ||
    computeAttemptKey({
      provider: provider || 'unknown',
      subscriptionId: subscriptionId || providerSubscriptionId || 'unknown',
      sinceIso,
    });
  const docId = computeSyntheticFailedInvoiceDocId(stableKey);
  const ref = db.collection('billingInvoices').doc(tenantId).collection('invoices').doc(docId);
  if (dryRun) return true;

  await ref.set(
    stripUndefinedDeep({
      amountInr: 0,
      status: 'failed',
      provider: provider || null,
      issuedAt: sinceIso,
      failedAt: nowIso,
      isSynthetic: true,
      sourceEvent: 'auto_cancel_no_payment_24h',
      rawEvent: 'auto_cancel',
      providerSubscriptionId: providerSubscriptionId || null,
      subscriptionId: subscriptionId || null,
      ...(billingAttemptId ? { billingAttemptId } : {}),
      attemptKey: stableKey,
      planId: planId || null,
      planVariantId: planVariantId ?? null,
      errorCode: reasonCode,
      errorDescription: reasonDescription,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }),
    { merge: true }
  );
  return true;
}

async function downgradeTenantToFree(options: {
  db: Firestore;
  tenantId: string;
  nowIso: string;
  reasonCode: string;
  reasonDescription: string;
  provider?: string;
  subscriptionId?: string;
  expectedBillingAttemptId?: string;
  expectedProvider?: string;
  expectedSubscriptionId?: string;
  dryRun: boolean;
}): Promise<void> {
  const { db, tenantId, nowIso, reasonCode, reasonDescription, provider, subscriptionId, expectedBillingAttemptId, expectedProvider, expectedSubscriptionId, dryRun } = options;
  if (dryRun) return;

  const billingRef = db.collection('tenantBilling').doc(tenantId);
  const tenantRef = db.collection('tenants').doc(tenantId);
  const auditRef = db.collection('tenantAuditLogs').doc();

  await db.runTransaction(async (tx) => {
    const billingSnap = await tx.get(billingRef);
    const tenantSnap = await tx.get(tenantRef);
    if (!tenantSnap.exists) {
      throw new Error('tenant_missing');
    }

    const billing = billingSnap.exists ? billingSnap.data() || {} : {};

    // Guard: only downgrade if this attempt still appears to be current.
    // This prevents an older attempt cancellation from downgrading a tenant that has started a newer autopay.
    const currentProvider = typeof (billing as any).billingProvider === 'string' ? String((billing as any).billingProvider).toLowerCase() : '';
    const currentSubId = typeof (billing as any).subscriptionId === 'string' ? String((billing as any).subscriptionId).trim() : '';
    const currentAttemptId = typeof (billing as any).billingAttemptId === 'string' ? String((billing as any).billingAttemptId).trim() : '';

    const expectedAttemptId = typeof expectedBillingAttemptId === 'string' ? expectedBillingAttemptId.trim() : '';
    const expectedSubId = typeof expectedSubscriptionId === 'string' ? expectedSubscriptionId.trim() : '';
    const expectedProv = typeof expectedProvider === 'string' ? expectedProvider.trim().toLowerCase() : '';

    if (expectedProv && currentProvider && expectedProv !== currentProvider) {
      return;
    }
    if (expectedAttemptId && currentAttemptId && expectedAttemptId !== currentAttemptId) {
      return;
    }
    if (expectedSubId && currentSubId && expectedSubId !== currentSubId) {
      return;
    }

    // Switch to Free and clear pending/subscription fields.
    tx.set(
      billingRef,
      {
        planId: 'free',
        planVariantId: null,
        couponCode: null,
        status: 'trial',
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
        // Stop automated provider reconciliation; user must re-upgrade.
        billingProvider: admin.firestore.FieldValue.delete(),
        subscriptionId: admin.firestore.FieldValue.delete(),
        storeProductId: admin.firestore.FieldValue.delete(),
        storeOrderId: admin.firestore.FieldValue.delete(),
        pendingPlanId: admin.firestore.FieldValue.delete(),
        pendingPlanVariantId: admin.firestore.FieldValue.delete(),
        pendingCouponCode: admin.firestore.FieldValue.delete(),
        billingAttemptId: admin.firestore.FieldValue.delete(),
        autoDowngradedAtIso: nowIso,
        autoDowngradeReason: reasonCode,
        autoDowngradeReasonDescription: reasonDescription,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      tenantRef,
      {
        billingTier: 'free',
        quotas: admin.firestore.FieldValue.delete(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    tx.set(
      auditRef,
      stripUndefinedDeep({
        tenantId,
        actorId: 'system',
        actorEmail: null,
        action: 'billing_auto_cancel_no_payment_24h',
        targetId: tenantId,
        targetType: 'billing',
        metadata: {
          provider: provider || null,
          subscriptionId: subscriptionId || null,
          reasonCode,
          reasonDescription,
        },
        createdAt: nowIso,
      }),
      { merge: false }
    );
  });
}

async function listInvoiceCandidates(
  db: Firestore,
  cutoffIso: string,
  maxTenants: number
): Promise<{ candidates: TenantCandidate[]; scanLimit: number; scanSaturated: boolean }> {
  // Global scan: any open invoice with issuedAt <= cutoff.
  // Note: This requires a collectionGroup index on (status, issuedAt) in many projects.
  const scanLimit = Math.max(1, Math.min(1000, maxTenants * 3));
  const query = db
    .collectionGroup('invoices')
    .where('status', '==', 'open')
    .orderBy('issuedAt', 'asc')
    .limit(scanLimit);

  const snap = await query.get();
  if (snap.empty) return { candidates: [], scanLimit, scanSaturated: false };

  const out = new Map<string, TenantCandidate>();
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const issuedAt = parseIso((data as any).issuedAt);
    if (!issuedAt || issuedAt > cutoffIso) {
      continue;
    }

    const invoiceProvider = typeof (data as any).provider === 'string' ? String((data as any).provider).trim().toLowerCase() : '';
    const invoiceSubscriptionId = typeof (data as any).subscriptionId === 'string' ? String((data as any).subscriptionId).trim() : '';
    const invoiceProviderSubscriptionId =
      typeof (data as any).providerSubscriptionId === 'string' ? String((data as any).providerSubscriptionId).trim() : '';
    const invoiceAttemptId = typeof (data as any).billingAttemptId === 'string' ? String((data as any).billingAttemptId).trim() : '';
    const subscriptionId = invoiceSubscriptionId || invoiceProviderSubscriptionId;

    const tenantId = doc.ref.parent?.parent?.id;
    if (!tenantId) continue;

    const existing = out.get(tenantId);
    if (!existing || issuedAt < existing.sinceIso) {
      out.set(tenantId, {
        tenantId,
        reason: 'open_invoice',
        sinceIso: issuedAt,
        ...(invoiceProvider ? { provider: invoiceProvider } : {}),
        ...(subscriptionId ? { subscriptionId } : {}),
        ...(invoiceAttemptId ? { billingAttemptId: invoiceAttemptId } : {}),
      });
    }

    if (out.size >= maxTenants) {
      break;
    }
  }

  const scanSaturated = snap.size >= scanLimit;
  return { candidates: Array.from(out.values()), scanLimit, scanSaturated };
}

async function listCheckoutRequiredCandidates(db: Firestore, cutoffMs: number, maxTenants: number): Promise<TenantCandidate[]> {
  const snap = await db.collection('tenantBilling').where('checkoutRequired', '==', true).limit(maxTenants).get();
  if (snap.empty) return [];

  const out: TenantCandidate[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const sinceIso =
      parseIso((data as any).checkoutRequiredSinceIso ?? (data as any).checkoutRequiredSince ?? (data as any).checkoutRequiredAtIso) || null;
    if (!sinceIso) continue;
    if (!isoOlderThan(sinceIso, cutoffMs)) continue;

    const provider = typeof (data as any).billingProvider === 'string' ? String((data as any).billingProvider).trim().toLowerCase() : '';
    const subscriptionId = typeof (data as any).subscriptionId === 'string' ? String((data as any).subscriptionId).trim() : '';
    const billingAttemptId = typeof (data as any).billingAttemptId === 'string' ? String((data as any).billingAttemptId).trim() : '';

    out.push({
      tenantId: doc.id,
      reason: 'checkout_required',
      sinceIso,
      ...(provider ? { provider } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
      ...(billingAttemptId ? { billingAttemptId } : {}),
    });
  }
  return out;
}

async function findCutoffSinceIsoForTenant(db: Firestore, tenantId: string, cutoffMs: number, cutoffIso: string): Promise<string | null> {
  // Prefer tenantBilling checkout timestamp.
  try {
    const billingSnap = await db.collection('tenantBilling').doc(tenantId).get();
    const billing = billingSnap.exists ? (billingSnap.data() || {}) : {};
    const sinceIso =
      parseIso((billing as any).checkoutRequiredSinceIso ?? (billing as any).checkoutRequiredSince ?? (billing as any).checkoutRequiredAtIso) || null;
    if (sinceIso && isoOlderThan(sinceIso, cutoffMs)) {
      return sinceIso;
    }
  } catch {
    // ignore
  }

  // Fallback: oldest open invoice issuedAt for this tenant.
  try {
    const snap = await db
      .collection('billingInvoices')
      .doc(tenantId)
      .collection('invoices')
      .where('status', '==', 'open')
      .orderBy('issuedAt', 'asc')
      .limit(1)
      .get();
    if (!snap.empty) {
      const issuedAt = parseIso((snap.docs[0].data() as any)?.issuedAt);
      if (issuedAt && issuedAt <= cutoffIso) {
        return issuedAt;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

export async function runBillingAutoCancelStalePending(db: Firestore, options: AutoCancelOptions): Promise<Stats> {
  const startedAtIso = new Date().toISOString();
  const runId = crypto.randomUUID();
  const thresholdMs = options.thresholdHours * 60 * 60 * 1000;
  // UPI AutoPay mandate flows can take time between mandate authentication and first capture.
  // Never auto-cancel these attempts earlier than this minimum, even if thresholdHours is smaller.
  const razorpayAutopayMinMs = 24 * 60 * 60 * 1000;
  const cutoffMs = Date.now() - thresholdMs;
  const cutoffIso = new Date(cutoffMs).toISOString();

  const leaseMs = typeof options.tenantLeaseMs === 'number' && Number.isFinite(options.tenantLeaseMs)
    ? Math.trunc(options.tenantLeaseMs)
    : 180_000;

  const stats: Stats = {
    jobLabel: options.jobLabel,
    runId,
    dryRun: options.dryRun,
    thresholdHours: options.thresholdHours,
    startedAtIso,
    candidatesFound: 0,
    tenantsProcessed: 0,
    tenantsSkippedLocked: 0,
    tenantsSkipped: 0,
    tenantsCancelled: 0,
    invoicesFailed: 0,
    invoicesCreated: 0,
    providerCancelsAttempted: 0,
    providerCancelsFailed: 0,
    errors: [],
  };

  const maxTenants = Math.max(1, Math.min(2000, Math.trunc(options.maxTenants ?? 200)));
  const targets = (options.tenantIds || []).map((t) => t.trim()).filter(Boolean);

  // Prevent overlapping executions (important for hourly schedulers at 1000+ tenants).
  // Skip for dry runs so manual investigation doesn't block the scheduler.
  const runLease = options.dryRun
    ? { token: 'dry_run', release: async () => undefined }
    : await acquireRunLease({
        db,
        leaseMs: typeof (options as any).runLeaseMs === 'number' ? (options as any).runLeaseMs : 2 * 60 * 60_000,
        jobLabel: options.jobLabel,
        runId,
      });
  if (!runLease) {
    log(options.verbose, 'skipping run (locked by another execution)', { jobLabel: options.jobLabel });
    stats.finishedAtIso = new Date().toISOString();
    return stats;
  }

  let fatalError: { tenantId: string; message: string } | null = null;

  try {
    let candidates: TenantCandidate[] = [];
    try {
      if (targets.length > 0) {
        const uniqueTargets = Array.from(new Set(targets));
        const out: TenantCandidate[] = [];
        for (const tenantId of uniqueTargets) {
          const sinceIso = await findCutoffSinceIsoForTenant(db, tenantId, cutoffMs, cutoffIso);
          if (!sinceIso) {
            log(options.verbose, 'skipping targeted tenant (not older than cutoff)', { tenantId, cutoffIso });
            continue;
          }
          out.push({ tenantId, reason: 'checkout_required', sinceIso });
        }
        candidates = out;
      } else {
        let fromInvoices: TenantCandidate[] = [];
        let invoiceScanSaturated = false;
        let invoiceScanLimit = 0;
        try {
          const invoiceScan = await listInvoiceCandidates(db, cutoffIso, maxTenants);
          fromInvoices = invoiceScan.candidates;
          invoiceScanSaturated = invoiceScan.scanSaturated;
          invoiceScanLimit = invoiceScan.scanLimit;
        } catch (error) {
          // Invoice collectionGroup queries can require a composite index. If it's missing,
          // don't fail the whole job; fall back to tenantBilling.checkoutRequired scanning.
          log(options.verbose, 'invoice candidate scan failed; falling back to checkoutRequired scan', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
        const fromCheckoutRequired = await listCheckoutRequiredCandidates(db, cutoffMs, maxTenants);

        if (invoiceScanSaturated) {
          log(true, 'invoice scan saturated (consider increasing BILLING_STALE_PENDING_MAX_TENANTS or adding pagination)', {
            scanLimit: invoiceScanLimit,
            maxTenants,
          });
        }
        if (fromCheckoutRequired.length >= maxTenants) {
          log(true, 'checkoutRequired scan saturated (consider increasing BILLING_STALE_PENDING_MAX_TENANTS)', { maxTenants });
        }

        const merged = new Map<string, TenantCandidate>();
        for (const c of [...fromInvoices, ...fromCheckoutRequired]) {
          const existing = merged.get(c.tenantId);
          if (!existing || c.sinceIso < existing.sinceIso) {
            merged.set(c.tenantId, c);
          }
        }
        candidates = Array.from(merged.values()).slice(0, maxTenants);
      }
    } catch (error) {
      stats.errors.push({ tenantId: '<scan>', message: error instanceof Error ? error.message : String(error) });
      stats.finishedAtIso = new Date().toISOString();
      return stats;
    }

    stats.candidatesFound = candidates.length;
    log(options.verbose, 'candidates scanned', { candidates: candidates.length, cutoffIso });

    for (const candidate of candidates) {
      const tenantId = candidate.tenantId;
      stats.tenantsProcessed += 1;

      const lease = options.dryRun
        ? { token: 'dry_run', release: async () => undefined }
        : await acquireTenantLease({ db, tenantId, leaseMs, jobLabel: options.jobLabel, runId });
      if (!lease) {
        log(options.verbose, 'skipping tenant (locked by another execution)', { tenantId });
        stats.tenantsSkippedLocked += 1;
        continue;
      }

      try {
        log(options.verbose, 'processing tenant', { tenantId, reason: candidate.reason, sinceIso: candidate.sinceIso });
        const billingRef = db.collection('tenantBilling').doc(tenantId);
        const billingSnap = await billingRef.get();
        const billing = billingSnap.exists ? (billingSnap.data() || {}) : {};

        const planId = typeof (billing as any).planId === 'string' ? String((billing as any).planId).toLowerCase() : 'free';
        const pendingPlanId = typeof (billing as any).pendingPlanId === 'string' ? String((billing as any).pendingPlanId).toLowerCase() : '';
        const planIdForHistory = pendingPlanId || planId;

        const provider = typeof (billing as any).billingProvider === 'string' ? String((billing as any).billingProvider).toLowerCase() : '';
        const subscriptionId = typeof (billing as any).subscriptionId === 'string' ? String((billing as any).subscriptionId).trim() : '';
        const billingAttemptId = typeof (billing as any).billingAttemptId === 'string' ? String((billing as any).billingAttemptId).trim() : '';
        const attemptProvider = (candidate.provider || provider || '').trim().toLowerCase();
        const attemptSubscriptionId = (candidate.subscriptionId || subscriptionId || '').trim();
        const attemptBillingAttemptId = (candidate.billingAttemptId || billingAttemptId || '').trim();
        const attemptKey = computeAttemptKey({
          attemptId: attemptBillingAttemptId || undefined,
          provider: attemptProvider,
          subscriptionId: attemptSubscriptionId,
          sinceIso: candidate.sinceIso,
        });

        const isCurrentAttempt = (() => {
          if (attemptBillingAttemptId && billingAttemptId) {
            return attemptBillingAttemptId === billingAttemptId;
          }
          if (attemptSubscriptionId && subscriptionId) {
            return attemptSubscriptionId === subscriptionId;
          }
          return false;
        })();

        log(options.verbose, 'attempt context', {
          tenantId,
          provider: attemptProvider || null,
          subscriptionId: attemptSubscriptionId || null,
          billingAttemptId: attemptBillingAttemptId || null,
          attemptKey,
          isCurrentAttempt,
        });

        const nowIso = new Date().toISOString();
        const reasonCode = 'no_payment_within_24h';
        const reasonDescription = `No payment was made within ${options.thresholdHours} hours of starting the subscription. Subscription cancelled and plan switched to Free.`;

        // Determine all stale attempts to cancel for this tenant.
        // - Always include the candidate attempt context.
        // - Also include any OTHER open invoices that are stale (issuedAt <= cutoff) so old pending attempts don't linger.
        const attemptsByKey = new Map<string, AttemptToCancel>();

        const addAttempt = (input: {
          provider: string;
          subscriptionId: string;
          billingAttemptId?: string;
          sinceIso: string;
          doc?: admin.firestore.QueryDocumentSnapshot;
        }): void => {
          const p = (input.provider || '').trim().toLowerCase();
          const s = (input.subscriptionId || '').trim();
          if (!p || !s) return;
          const sinceIso = parseIso(input.sinceIso) || input.sinceIso;
          const key = computeAttemptKey({
            attemptId: (input.billingAttemptId || '').trim() || undefined,
            provider: p,
            subscriptionId: s,
            sinceIso,
          });

          const existing = attemptsByKey.get(key);
          if (existing) {
            if (input.doc) existing.invoiceDocs.push(input.doc);
            if (!existing.billingAttemptId && input.billingAttemptId) existing.billingAttemptId = input.billingAttemptId;
            return;
          }
          attemptsByKey.set(key, {
            provider: p,
            subscriptionId: s,
            billingAttemptId: input.billingAttemptId,
            sinceIso,
            attemptKey: key,
            invoiceDocs: input.doc ? [input.doc] : [],
          });
        };

        // Candidate attempt (if available)
        if (attemptProvider && attemptSubscriptionId) {
          addAttempt({
            provider: attemptProvider,
            subscriptionId: attemptSubscriptionId,
            billingAttemptId: attemptBillingAttemptId || undefined,
            sinceIso: candidate.sinceIso,
          });
        }

        // Other stale open invoices
        try {
          const openSnap = await db
            .collection('billingInvoices')
            .doc(tenantId)
            .collection('invoices')
            .where('status', '==', 'open')
            .limit(250)
            .get();

          for (const doc of openSnap.docs) {
            const data = doc.data() as any;
            const issuedAtIso = parseIso(data?.issuedAt);
            if (!issuedAtIso) continue;
            if (!isoOlderThan(issuedAtIso, cutoffMs)) continue;

            const invoiceProvider = typeof data?.provider === 'string' ? String(data.provider).trim().toLowerCase() : '';
            const invoiceAttemptId = typeof data?.billingAttemptId === 'string' ? String(data.billingAttemptId).trim() : '';
            const invoiceSubscriptionId = typeof data?.subscriptionId === 'string' ? String(data.subscriptionId).trim() : '';
            const invoiceProviderSubscriptionId =
              typeof data?.providerSubscriptionId === 'string' ? String(data.providerSubscriptionId).trim() : '';
            const effectiveSubscription = invoiceProviderSubscriptionId || invoiceSubscriptionId;
            if (!invoiceProvider || !effectiveSubscription) continue;

            // Respect candidate provider if known (avoid cross-provider false positives)
            if (attemptProvider && invoiceProvider && invoiceProvider !== attemptProvider) {
              continue;
            }

            addAttempt({
              provider: invoiceProvider,
              subscriptionId: effectiveSubscription,
              billingAttemptId: invoiceAttemptId || undefined,
              sinceIso: issuedAtIso,
              doc,
            });
          }
        } catch {
          // ignore; we'll still process the candidate attempt
        }

        const attempts = Array.from(attemptsByKey.values()).sort((a, b) => a.sinceIso.localeCompare(b.sinceIso));
        if (attempts.length === 0) {
          log(options.verbose, 'skipping tenant (no stale attempts found)', { tenantId });
          stats.tenantsSkipped += 1;
          continue;
        }

        let cancelledCurrentAttempt = false;

        for (const attempt of attempts) {
          const isRazorpayAutopayAuthenticatedAttempt = (() => {
            if (attempt.provider !== 'razorpay') return false;
            for (const doc of attempt.invoiceDocs) {
              try {
                const data = (doc.data() || {}) as any;
                const isSynthetic = data?.isSynthetic === true;
                if (!isSynthetic) continue;
                const sourceEvent = typeof data?.sourceEvent === 'string' ? String(data.sourceEvent).trim() : '';
                const rawEvent = typeof data?.rawEvent === 'string' ? String(data.rawEvent).trim() : '';
                const ev = sourceEvent || rawEvent;
                if (ev === 'subscription.authenticated' || ev === 'subscription.activated') {
                  return true;
                }
              } catch {
                // ignore
              }
            }
            return false;
          })();

          if (isRazorpayAutopayAuthenticatedAttempt) {
            const sinceMs = Date.parse(attempt.sinceIso);
            const ageMs = Number.isFinite(sinceMs) ? Date.now() - sinceMs : Number.POSITIVE_INFINITY;
            if (ageMs < razorpayAutopayMinMs) {
              log(options.verbose, 'skipping autopay-authenticated razorpay attempt (too recent to auto-cancel)', {
                tenantId,
                attemptKey: attempt.attemptKey,
                subscriptionId: attempt.subscriptionId,
                ageHours: Math.round((ageMs / (60 * 60 * 1000)) * 10) / 10,
              });
              continue;
            }
          }

          const isAttemptCurrent = (() => {
            if (attempt.billingAttemptId && billingAttemptId) {
              return attempt.billingAttemptId === billingAttemptId;
            }
            if (attempt.subscriptionId && subscriptionId) {
              return attempt.subscriptionId === subscriptionId;
            }
            return false;
          })();

          // Only auto-cancel if there has been no payment for this specific attempt.
          // (Tenants may have historical paid invoices from previous billing cycles.)
          const paid = await hasPaidInvoiceForAttempt({
            db,
            tenantId,
            sinceIso: attempt.sinceIso,
            attemptId: attempt.billingAttemptId || undefined,
            provider: attempt.provider || undefined,
            subscriptionId: attempt.subscriptionId || undefined,
          });
          if (paid) {
            log(options.verbose, 'skipping attempt (already has paid invoice)', {
              tenantId,
              attemptKey: attempt.attemptKey,
              provider: attempt.provider,
              subscriptionId: attempt.subscriptionId,
            });
            continue;
          }

          // Cancel provider subscription (required; fatal if cannot cancel).
          if (!options.dryRun) {
            if (attempt.provider === 'razorpay' && attempt.subscriptionId) {
              if (isAttemptCurrent) {
                // Suppress the Razorpay webhook's generic cancellation notice/email for a short window.
                // The job sends the correct reasoned notification.
                try {
                  await billingRef.set(
                    {
                      suppressProviderCancelNotificationUntilIso: addHoursIso(nowIso, 2),
                      lastSystemCancelContext: {
                        source: 'billing_stale_pending_job',
                        reasonCode,
                        reasonDescription,
                        atIso: nowIso,
                        provider: attempt.provider || null,
                        subscriptionId: attempt.subscriptionId || null,
                        sinceIso: attempt.sinceIso,
                      },
                      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                    },
                    { merge: true }
                  );
                } catch {
                  // best-effort
                }
              }

              stats.providerCancelsAttempted += 1;
              try {
                log(options.verbose, 'cancelling razorpay subscription', { tenantId, subscriptionId: attempt.subscriptionId });
                await cancelRazorpaySubscription({ subscriptionId: attempt.subscriptionId, cancelAtCycleEnd: false });
              } catch (error) {
                stats.providerCancelsFailed += 1;
                const message = error instanceof Error ? error.message : String(error);
                log(options.verbose, 'razorpay cancel failed (fatal)', {
                  tenantId,
                  error: message,
                });
                if (message.startsWith('razorpay_')) {
                  throw new Error(message);
                }
                throw new Error(`razorpay_cancel_failed: ${message}`);
              }
            }

            if ((attempt.provider === 'play' || attempt.provider === 'google_play') && attempt.subscriptionId) {
              const productId = typeof (billing as any).storeProductId === 'string' ? String((billing as any).storeProductId).trim() : '';
              const packageName = (process.env.GOOGLE_PLAY_PACKAGE_NAME || '').trim();
              if (!packageName) {
                throw new Error('google_play_package_name_missing');
              }
              if (!productId) {
                throw new Error('google_play_product_id_missing');
              }

              stats.providerCancelsAttempted += 1;
              log(options.verbose, 'cancelling google play subscription', { tenantId, productId, packageName });
              await cancelGooglePlaySubscription({ packageName, productId, purchaseToken: attempt.subscriptionId });
            }
          }

          // Mark open invoices failed for this attempt.
          let failedInvoices = 0;
          if (attempt.invoiceDocs.length) {
            failedInvoices = await failInvoicesByDocs({
              db,
              docs: attempt.invoiceDocs,
              nowIso,
              reasonCode,
              reasonDescription,
              attemptKey: attempt.attemptKey,
              billingAttemptId: attempt.billingAttemptId,
              dryRun: options.dryRun,
            });
          } else {
            failedInvoices = await failOpenInvoicesForTenant({
              db,
              tenantId,
              nowIso,
              reasonCode,
              reasonDescription,
              attemptKey: attempt.attemptKey,
              billingAttemptId: attempt.billingAttemptId,
              provider: attempt.provider,
              subscriptionId: attempt.subscriptionId,
              sinceIso: attempt.sinceIso,
              dryRun: options.dryRun,
            });
          }
          stats.invoicesFailed += failedInvoices;

          // If there were no open invoices, create a synthetic failed invoice so history shows a reason.
          if (failedInvoices === 0) {
            const created = await createFailedInvoiceIfMissing({
              db,
              tenantId,
              nowIso,
              sinceIso: attempt.sinceIso,
              provider: attempt.provider,
              providerSubscriptionId: attempt.subscriptionId,
              subscriptionId: attempt.subscriptionId,
              planId: planIdForHistory,
              planVariantId: typeof (billing as any).planVariantId === 'string' ? String((billing as any).planVariantId) : null,
              attemptKey: attempt.attemptKey,
              billingAttemptId: attempt.billingAttemptId,
              reasonCode,
              reasonDescription,
              dryRun: options.dryRun,
            });
            if (created) {
              stats.invoicesCreated += 1;
            }
          }

          if (isAttemptCurrent) {
            cancelledCurrentAttempt = true;
          } else {
            log(options.verbose, 'cancelled non-current attempt (no downgrade/notify)', {
              tenantId,
              attemptKey: attempt.attemptKey,
              provider: attempt.provider,
              subscriptionId: attempt.subscriptionId,
            });
          }
        }

        // Downgrade + notify only if the cancelled attempt is still the tenant's current attempt.
        if (cancelledCurrentAttempt) {
          await downgradeTenantToFree({
            db,
            tenantId,
            nowIso,
            reasonCode,
            reasonDescription,
            provider: attemptProvider || undefined,
            subscriptionId: attemptSubscriptionId || undefined,
            expectedProvider: attemptProvider || undefined,
            expectedSubscriptionId: attemptSubscriptionId || undefined,
            expectedBillingAttemptId: attemptBillingAttemptId || undefined,
            dryRun: options.dryRun,
          });

          if (!options.dryRun) {
            try {
              const res = await sendTenantBillingEventNotification({
                tenantId,
                kind: 'subscription_cancelled',
                title: 'Subscription cancelled',
                body: `No payment was made within ${options.thresholdHours} hours. Your plan has been switched to Free.`,
                priority: 'high',
                dedupeKey: `stale_pending_cancel:${attemptKey}`,
                metadata: {
                  source: 'billing_stale_pending_job',
                  provider: attemptProvider || null,
                  providerSubscriptionId: attemptSubscriptionId || null,
                  sinceIso: candidate.sinceIso,
                  reasonCode,
                  attemptKey,
                },
              });
              log(options.verbose, 'sent billing notification', {
                tenantId,
                ok: res.ok,
                pushSent: res.pushSent,
                emailRecipients: res.emailRecipients,
                emailSummary: res.emailSummary || null,
              });
            } catch (notifyError) {
              log(options.verbose, 'billing notification failed (continuing)', {
                tenantId,
                error: notifyError instanceof Error ? notifyError.message : String(notifyError),
              });
            }
          }
        }

        stats.tenantsCancelled += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stats.errors.push({ tenantId, message });

      // Hard-fail the job on Play cancel inability (missing config/metadata or API call failure).
      if (
        message === 'google_play_package_name_missing' ||
        message === 'google_play_product_id_missing' ||
        message.startsWith('google_play_') ||
        message.startsWith('razorpay_')
      ) {
        fatalError = { tenantId, message };
        break;
      }
    } finally {
      await lease.release().catch(() => undefined);
    }
    }

    if (fatalError) {
      log(options.verbose, 'fatal error encountered; aborting job', fatalError);
      stats.fatalError = fatalError;
    }

    stats.finishedAtIso = new Date().toISOString();
    return stats;
  } finally {
    await runLease.release().catch(() => undefined);
  }
}

// Test-only hooks (not part of the public API).
export const __testOnly = {
  computeAttemptKey,
  computeSyntheticFailedInvoiceDocId,
  acquireTenantLease,
  acquireRunLease,
};
