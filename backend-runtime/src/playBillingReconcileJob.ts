import * as admin from 'firebase-admin';
import { getFirestore } from './firebaseAdmin';
import { stripUndefinedDeep } from './lib/stripUndefinedDeep';
import { sendTenantBillingEventNotification } from './billing/billingNotifier';
import { getPlanVariantById, listPlanVariants } from './billing/catalog';
import { recordBillingOpsEvent } from './billing/billingOps';

function parseBoolean(value?: string | null): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function parseMs(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'string' ? value.trim() : '';
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseCollectionDocPath(value?: string | null): { collection: string; docId: string } | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const parts = raw.split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  return { collection: parts[0], docId: parts[1] };
}

function parseOptionalInt(value?: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function parseTenantIds(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function logVerbose(enabled: boolean, message: string, extra?: Record<string, unknown>): void {
  if (!enabled) return;
  if (extra) {
    console.log(`[play_billing_reconcile] ${message}`, extra);
  } else {
    console.log(`[play_billing_reconcile] ${message}`);
  }
}

function formatIsoIstForDisplay(iso: string | undefined | null): string | undefined {
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
    // ignore
  }

  return date.toISOString();
}

type GooglePlayServiceAccount = {
  client_email: string;
  private_key: string;
  project_id?: string;
};

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
    return {
      client_email: email,
      private_key: key,
      project_id: typeof parsed?.project_id === 'string' ? parsed.project_id : undefined,
    };
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
  const token = typeof auth?.access_token === 'string' ? auth.access_token : '';
  if (!token) {
    throw new Error('google_play_token_failed');
  }

  const expiresAtMs = typeof auth?.expiry_date === 'number' && Number.isFinite(auth.expiry_date) ? auth.expiry_date : now + 50 * 60_000;
  cachedGooglePlayToken = { accessToken: token, expiresAtMs };
  return token;
}

export type GooglePlaySubscriptionPurchase = {
  orderId?: string;
  expiryTimeMillis?: string;
  acknowledgementState?: number;
  paymentState?: number;
  cancelReason?: number;
  purchaseType?: number;
  purchaseState?: number;
  startTimeMillis?: string;
  autoRenewing?: boolean;
  userCancellationTimeMillis?: string;
};

async function fetchGooglePlaySubscriptionPurchase(options: {
  packageName: string;
  productId: string;
  purchaseToken: string;
}): Promise<GooglePlaySubscriptionPurchase> {
  if (process.env.TEST_MODE === '1') {
    return {
      orderId: `test_${options.purchaseToken}`,
      expiryTimeMillis: String(Date.now() + 7 * 24 * 60 * 60_000),
      acknowledgementState: 1,
      paymentState: 1,
      autoRenewing: true,
    };
  }

  const accessToken = await getGooglePlayAccessToken();
  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(options.packageName)}` +
    `/purchases/subscriptions/${encodeURIComponent(options.productId)}/tokens/${encodeURIComponent(options.purchaseToken)}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await resp.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!resp.ok) {
    const err = new Error(text || `google_play_fetch_failed_${resp.status}`);
    (err as any).status = resp.status;
    (err as any).providerPayload = json;
    throw err;
  }
  return (json || {}) as GooglePlaySubscriptionPurchase;
}

let schedulerStarted = false;
let schedulerTimer: NodeJS.Timeout | null = null;
let nextRunAt: Date | null = null;
let lastRunAt: Date | null = null;
let isRunning = false;

export type PlayBillingReconcileSchedulerStatus = {
  enabled: boolean;
  schedulerStarted: boolean;
  intervalMs: number;
  nextRunAt: string | null;
  lastRunAt: string | null;
  isRunning: boolean;
};

export function getPlayBillingReconcileSchedulerStatus(): PlayBillingReconcileSchedulerStatus {
  const intervalMs = parseMs(process.env.PLAY_BILLING_RECONCILE_INTERVAL_MS, 6 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000);
  const enabled = parseBoolean(process.env.PLAY_BILLING_RECONCILE_ENABLED);
  return {
    enabled,
    schedulerStarted,
    intervalMs,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    isRunning,
  };
}

export function startPlayBillingReconcileScheduler(): void {
  const enabled = parseBoolean(process.env.PLAY_BILLING_RECONCILE_ENABLED);
  if (!enabled) {
    return;
  }

  if (schedulerStarted) return;
  schedulerStarted = true;

  const runOnStart = parseBoolean(process.env.PLAY_BILLING_RECONCILE_RUN_ON_START);
  if (runOnStart) {
    const startDelayMs = parseMs(process.env.PLAY_BILLING_RECONCILE_START_DELAY_MS, 30_000, 0, 10 * 60_000);
    const timer = setTimeout(() => {
      runPlayBillingReconcileJob({ reason: 'startup' }).catch((err) => {
        console.error('[play_billing_reconcile] startup run failed', err);
      });
    }, startDelayMs);
    timer.unref?.();
  }

  scheduleNext();
}

export function stopPlayBillingReconcileScheduler(): void {
  schedulerStarted = false;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  nextRunAt = null;
}

export type PlayBillingReconcileRunStats = {
  skippedBecauseAlreadyRunning: boolean;
  skippedBecauseLockNotAcquired: boolean;
  tenantsScanned: number;
  tenantErrors: number;
  configErrors: number;
  lock?: {
    enabled: boolean;
    acquired: boolean;
    holderId?: string;
    leaseExpiresAtIso?: string;
    docPath?: string;
  };
};

export async function runPlayBillingReconcileOnce(): Promise<PlayBillingReconcileRunStats> {
  return runPlayBillingReconcileJob({ reason: 'manual' });
}

function getLockHolderId(): string {
  const machine = (process.env.FLY_MACHINE_ID || '').trim();
  const hostname = (process.env.HOSTNAME || '').trim();
  const runner = machine || hostname || 'unknown';
  return `${runner}:${process.pid}`;
}

async function tryAcquireDistributedLeaseLock(db: admin.firestore.Firestore): Promise<
  | {
      enabled: false;
      acquired: true;
    }
  | {
      enabled: true;
      acquired: boolean;
      docPath: string;
      holderId: string;
      leaseExpiresAtIso: string;
      cursorAfterDocId?: string;
      currentHolderId?: string;
      currentLeaseExpiresAtIso?: string;
    }
> {
  // Default to enabled: if you're running multiple machines, this prevents 20x duplicate reconciles.
  const enabled = process.env.PLAY_BILLING_RECONCILE_LOCK_ENABLED === undefined
    ? true
    : parseBoolean(process.env.PLAY_BILLING_RECONCILE_LOCK_ENABLED);

  if (!enabled) {
    return { enabled: false, acquired: true };
  }

  const docPath = (process.env.PLAY_BILLING_RECONCILE_LOCK_DOC || '').trim() || 'billingLocks/play_billing_reconcile';
  const parsedPath = parseCollectionDocPath(docPath);
  if (!parsedPath) {
    throw new Error('play_reconcile_invalid_lock_doc');
  }

  const leaseMs = parseMs(process.env.PLAY_BILLING_RECONCILE_LOCK_LEASE_MS, 15 * 60_000, 30_000, 60 * 60_000);
  const nowMs = Date.now();
  const leaseExpiresAtMs = nowMs + leaseMs;
  const holderId = getLockHolderId();
  const lockRef = db.collection(parsedPath.collection).doc(parsedPath.docId);

  let acquired = false;
  let currentHolderId: string | undefined;
  let currentLeaseExpiresAtIso: string | undefined;
  let cursorAfterDocId: string | undefined;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    const data = snap.exists ? (snap.data() as any) : null;
    const currentExpiresAtMs = typeof data?.leaseExpiresAtMs === 'number' ? data.leaseExpiresAtMs : 0;
    const currentHolder = typeof data?.holderId === 'string' ? data.holderId : undefined;
    const existingCursor = typeof data?.cursorAfterDocId === 'string' ? data.cursorAfterDocId.trim() : '';
    cursorAfterDocId = existingCursor || undefined;

    if (currentExpiresAtMs && currentExpiresAtMs > nowMs) {
      acquired = false;
      currentHolderId = currentHolder;
      currentLeaseExpiresAtIso = new Date(currentExpiresAtMs).toISOString();
      return;
    }

    acquired = true;
    tx.set(
      lockRef,
      {
        holderId,
        leaseMs,
        leaseExpiresAtMs,
        leaseExpiresAtIso: new Date(leaseExpiresAtMs).toISOString(),
        acquiredAtMs: nowMs,
        acquiredAtIso: new Date(nowMs).toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  return {
    enabled: true,
    acquired,
    docPath,
    holderId,
    leaseExpiresAtIso: new Date(leaseExpiresAtMs).toISOString(),
    ...(cursorAfterDocId ? { cursorAfterDocId } : {}),
    ...(currentHolderId ? { currentHolderId } : {}),
    ...(currentLeaseExpiresAtIso ? { currentLeaseExpiresAtIso } : {}),
  };
}

function scheduleNext(): void {
  if (!schedulerStarted) return;

  const enabled = parseBoolean(process.env.PLAY_BILLING_RECONCILE_ENABLED);
  if (!enabled) return;

  const intervalMs = parseMs(process.env.PLAY_BILLING_RECONCILE_INTERVAL_MS, 6 * 60 * 60_000, 60_000, 7 * 24 * 60 * 60_000);
  nextRunAt = new Date(Date.now() + intervalMs);

  schedulerTimer = setTimeout(() => {
    schedulerTimer = null;
    runPlayBillingReconcileJob({ reason: 'interval' })
      .catch((err) => {
        console.error('[play_billing_reconcile] scheduled run failed', err);
      })
      .finally(() => {
        if (schedulerStarted) {
          scheduleNext();
        }
      });
  }, intervalMs);

  schedulerTimer.unref?.();
}

async function runPlayBillingReconcileJob(options: { reason: 'startup' | 'interval' | 'manual' }): Promise<PlayBillingReconcileRunStats> {
  if (isRunning) {
    console.warn('[play_billing_reconcile] skipped: already running', { reason: options.reason });
    return {
      skippedBecauseAlreadyRunning: true,
      skippedBecauseLockNotAcquired: false,
      tenantsScanned: 0,
      tenantErrors: 0,
      configErrors: 0,
    };
  }

  isRunning = true;
  lastRunAt = new Date();

  const db = getFirestore();

  // Distributed lock to prevent multiple machines from reconciling concurrently.
  // (Important when running many Fly machines.)
  let lockInfo:
    | PlayBillingReconcileRunStats['lock']
    | {
        enabled: true;
        acquired: boolean;
        holderId?: string;
        leaseExpiresAtIso?: string;
        docPath?: string;
        currentHolderId?: string;
        currentLeaseExpiresAtIso?: string;
      }
    | undefined;
  try {
    const lock = await tryAcquireDistributedLeaseLock(db);
    if (lock.enabled === false) {
      lockInfo = { enabled: false, acquired: true };
    } else {
      lockInfo = {
        enabled: true,
        acquired: lock.acquired,
        holderId: lock.holderId,
        leaseExpiresAtIso: lock.leaseExpiresAtIso,
        docPath: lock.docPath,
      };

      if (!lock.acquired) {
        console.info('[play_billing_reconcile] skipped: lock not acquired', {
          reason: options.reason,
          docPath: lock.docPath,
          currentHolderId: lock.currentHolderId,
          currentLeaseExpiresAtIso: lock.currentLeaseExpiresAtIso,
        });
        isRunning = false;
        return {
          skippedBecauseAlreadyRunning: false,
          skippedBecauseLockNotAcquired: true,
          tenantsScanned: 0,
          tenantErrors: 0,
          configErrors: 0,
          lock: lockInfo,
        };
      }

      // Carry over any pagination cursor from the lock doc.
      if (lock.cursorAfterDocId) {
        (lockInfo as any).cursorAfterDocId = lock.cursorAfterDocId;
      }
    }
  } catch (error) {
    console.error('[play_billing_reconcile] lock acquisition failed', error);
    // Fail open: if lock acquisition fails due to misconfig, we prefer not to run on many machines.
    isRunning = false;
    return {
      skippedBecauseAlreadyRunning: false,
      skippedBecauseLockNotAcquired: true,
      tenantsScanned: 0,
      tenantErrors: 0,
      configErrors: 1,
      lock: {
        enabled: true,
        acquired: false,
        docPath: (process.env.PLAY_BILLING_RECONCILE_LOCK_DOC || '').trim() || 'billingLocks/play_billing_reconcile',
      },
    };
  }

  const packageName = (process.env.GOOGLE_PLAY_PACKAGE_NAME || '').trim();
  if (!packageName) {
    await recordBillingOpsEvent(db, {
      provider: 'play',
      type: 'play_reconcile_unconfigured',
      severity: 'error',
      message: 'Missing GOOGLE_PLAY_PACKAGE_NAME (required for Play reconciliation)',
      requestPath: 'scheduler:play_billing_reconcile',
    });
    isRunning = false;
    return {
      skippedBecauseAlreadyRunning: false,
      skippedBecauseLockNotAcquired: false,
      tenantsScanned: 0,
      tenantErrors: 0,
      configErrors: 1,
      lock: lockInfo as any,
    };
  }

  const dryRun = parseBoolean(process.env.PLAY_BILLING_RECONCILE_DRY_RUN);
  const maxTenants = parseOptionalInt(process.env.PLAY_BILLING_RECONCILE_MAX_TENANTS) ?? 200;
  const tenantIds = parseTenantIds(process.env.PLAY_BILLING_RECONCILE_TENANT_IDS);
  const verbose = parseBoolean(process.env.PLAY_BILLING_RECONCILE_VERBOSE);

  let tenantsScanned = 0;
  let tenantErrors = 0;
  try {
    const docsToProcess: Array<{ tenantId: string; billing: Record<string, unknown> }> = [];

    if (tenantIds.length > 0) {
      logVerbose(verbose, 'targeting tenants', { tenantIds, maxTenants });
      for (const tenantId of tenantIds.slice(0, maxTenants)) {
        const snap = await db.collection('tenantBilling').doc(tenantId).get();
        const data = snap.exists ? (snap.data() as Record<string, unknown>) : null;
        if (!data) {
          logVerbose(verbose, 'skipped tenant (no tenantBilling doc)', { tenantId });
          continue;
        }
        if (typeof (data as any).billingProvider !== 'string' || (data as any).billingProvider !== 'play') {
          logVerbose(verbose, 'skipped tenant (not play provider)', {
            tenantId,
            billingProvider: typeof (data as any).billingProvider === 'string' ? (data as any).billingProvider : null,
          });
          continue;
        }
        docsToProcess.push({ tenantId, billing: data });
      }
    } else {
      logVerbose(verbose, 'auto-scan mode (billingProvider==play)', { maxTenants });
      const tenantBilling = db.collection('tenantBilling');
      const cursor = typeof (lockInfo as any)?.cursorAfterDocId === 'string' ? String((lockInfo as any).cursorAfterDocId) : '';

      const baseQuery = tenantBilling
        .where('billingProvider', '==', 'play')
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(maxTenants);

      const firstSnap = cursor ? await baseQuery.startAfter(cursor).get() : await baseQuery.get();
      const finalSnap = firstSnap.empty && cursor ? await baseQuery.get() : firstSnap;

      for (const doc of finalSnap.docs) {
        docsToProcess.push({ tenantId: doc.id, billing: (doc.data() || {}) as Record<string, unknown> });
      }

      // Persist new cursor (round-robin) for the next run.
      const lastDoc = finalSnap.docs.length > 0 ? finalSnap.docs[finalSnap.docs.length - 1] : null;
      if (lastDoc && lockInfo && (lockInfo as any).enabled === true && (lockInfo as any).acquired === true) {
        const docPath = typeof (lockInfo as any).docPath === 'string' ? String((lockInfo as any).docPath) : '';
        const parsed = parseCollectionDocPath(docPath);
        if (parsed) {
          const lockRef = db.collection(parsed.collection).doc(parsed.docId);
          await lockRef.set(
            {
              cursorAfterDocId: lastDoc.id,
              cursorUpdatedAtIso: new Date().toISOString(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
          );
          logVerbose(verbose, 'updated cursor', { cursorAfterDocId: lastDoc.id, docPath });
        }
      }
    }

    for (const { tenantId, billing } of docsToProcess) {
      tenantsScanned++;
      const purchaseToken = typeof (billing as any).subscriptionId === 'string' ? (billing as any).subscriptionId.trim() : '';
      const productId = typeof (billing as any).storeProductId === 'string' ? (billing as any).storeProductId.trim() : '';
      if (!purchaseToken || !productId) {
        continue;
      }

      try {
        const purchase = await fetchGooglePlaySubscriptionPurchase({ packageName, productId, purchaseToken });
        const expiryMs = typeof purchase.expiryTimeMillis === 'string' ? Number(purchase.expiryTimeMillis) : NaN;
        const expiryIso = Number.isFinite(expiryMs) ? new Date(expiryMs).toISOString() : null;
        const expiryDisplay = formatIsoIstForDisplay(expiryIso || undefined);

        const paymentState = typeof purchase.paymentState === 'number' ? purchase.paymentState : null;
        const orderId = typeof purchase.orderId === 'string' ? purchase.orderId.trim() : '';
        const autoRenewing = typeof purchase.autoRenewing === 'boolean' ? purchase.autoRenewing : null;

        const nowIso = new Date().toISOString();
        const nowMs = Date.now();
        const isExpired = Number.isFinite(expiryMs) && expiryMs <= nowMs;

        const lastRenewalOrderId = typeof (billing as any).lastStoreRenewalNotifiedOrderId === 'string' ? (billing as any).lastStoreRenewalNotifiedOrderId : '';
        const lastRenewalExpiryIso = typeof (billing as any).lastStoreRenewalNotifiedExpiryIso === 'string' ? (billing as any).lastStoreRenewalNotifiedExpiryIso : '';
        const lastCancelExpiryIso = typeof (billing as any).lastStoreCancelNotifiedExpiryIso === 'string' ? (billing as any).lastStoreCancelNotifiedExpiryIso : '';
        const lastExpiredExpiryIso = typeof (billing as any).lastStoreExpiredNotifiedExpiryIso === 'string' ? (billing as any).lastStoreExpiredNotifiedExpiryIso : '';

        let resolvedPlanId = typeof (billing as any).planId === 'string' ? (billing as any).planId : 'pro';
        let resolvedVariantId = typeof (billing as any).planVariantId === 'string' ? (billing as any).planVariantId : null;
        let resolvedPriceInr = 0;

        if (resolvedVariantId) {
          const variant = await getPlanVariantById(db, resolvedVariantId);
          if (variant) {
            resolvedPlanId = variant.planId;
            resolvedPriceInr = Number.isFinite(variant.priceInr) ? Math.max(0, Math.trunc(variant.priceInr)) : 0;
          }
        } else {
          const configured = await listPlanVariants(db, { includeInactive: false });
          const match = configured.find((v) => typeof (v as any).playProductId === 'string' && (v as any).playProductId === productId);
          if (match) {
            resolvedVariantId = match.id;
            resolvedPlanId = match.planId;
            resolvedPriceInr = Number.isFinite(match.priceInr) ? Math.max(0, Math.trunc(match.priceInr)) : 0;
          }
        }

        const billingRef = db.collection('tenantBilling').doc(tenantId);
        const tenantRef = db.collection('tenants').doc(tenantId);

        // Expired → downgrade to Free.
        if (isExpired) {
          if (expiryIso && expiryIso === lastExpiredExpiryIso) {
            continue;
          }

          if (!dryRun) {
            await billingRef.set(
              {
                planId: 'free',
                planVariantId: null,
                couponCode: null,
                status: 'canceled',
                billingProvider: 'play',
                subscriptionId: purchaseToken,
                renewalDate: null,
                cancelAtCycleEnd: admin.firestore.FieldValue.delete(),
                scheduledDowngradePlanId: admin.firestore.FieldValue.delete(),
                scheduledDowngradeAt: admin.firestore.FieldValue.delete(),
                limitsSnapshot: admin.firestore.FieldValue.delete(),
                limitsSnapshotAt: admin.firestore.FieldValue.delete(),
                delinquentSince: admin.firestore.FieldValue.delete(),
                delinquentSinceIso: admin.firestore.FieldValue.delete(),
                lastStoreExpiredNotifiedExpiryIso: expiryIso || nowIso,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );

            await tenantRef.set(
              {
                billingTier: 'free',
                quotas: admin.firestore.FieldValue.delete(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
          }

          void sendTenantBillingEventNotification({
            tenantId,
            kind: 'subscription_cancelled',
            title: 'Subscription cancelled',
            body: 'Your subscription has ended and the plan is now Free.',
            priority: 'medium',
            metadata: {
              provider: 'play',
              planId: resolvedPlanId,
              planVariantId: resolvedVariantId || null,
              productId,
              subscriptionId: purchaseToken,
              orderId: orderId || null,
              renewalDate: expiryIso,
              paymentState,
              source: 'play_reconcile',
            },
          }).catch(() => undefined);

          continue;
        }

        // Payment pending.
        if (paymentState === 0) {
          if ((billing as any).planLockedByOrg === true) {
            continue;
          }
          if (!dryRun) {
            await billingRef.set(
              stripUndefinedDeep({
                planId: resolvedPlanId,
                planVariantId: resolvedVariantId || null,
                status: 'delinquent',
                billingProvider: 'play',
                subscriptionId: purchaseToken,
                renewalDate: expiryIso,
                storeProductId: productId,
                ...(orderId ? { storeOrderId: orderId } : {}),
                lastStoreVerifyAtIso: nowIso,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }),
              { merge: true }
            );
          }

          void sendTenantBillingEventNotification({
            tenantId,
            kind: 'subscription_pending',
            title: 'Subscription pending',
            body: 'Your subscription is pending confirmation from Google Play.',
            priority: 'medium',
            metadata: {
              provider: 'play',
              planId: resolvedPlanId,
              productId,
              subscriptionId: purchaseToken,
              orderId: orderId || null,
              renewalDate: expiryIso,
              paymentState,
              source: 'play_reconcile',
            },
          }).catch(() => undefined);

          continue;
        }

        // Auto-renew off → cancellation scheduled.
        if (autoRenewing === false) {
          if (expiryIso && expiryIso === lastCancelExpiryIso) {
            // already notified
          } else {
            if (!dryRun) {
              await billingRef.set(
                stripUndefinedDeep({
                  planId: resolvedPlanId,
                  planVariantId: resolvedVariantId || null,
                  status: 'active',
                  billingProvider: 'play',
                  subscriptionId: purchaseToken,
                  renewalDate: expiryIso,
                  storeProductId: productId,
                  ...(orderId ? { storeOrderId: orderId } : {}),
                  cancelAtCycleEnd: true,
                  scheduledDowngradePlanId: 'free',
                  ...(expiryIso ? { scheduledDowngradeAt: expiryIso } : {}),
                  lastStoreCancelNotifiedExpiryIso: expiryIso || nowIso,
                  lastStoreVerifyAtIso: nowIso,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                }),
                { merge: true }
              );
            }

            void sendTenantBillingEventNotification({
              tenantId,
              kind: 'subscription_cancelled',
              title: 'Subscription cancelled',
              body: expiryDisplay
                ? `Your subscription was cancelled (auto-renew turned off). Your plan remains active until ${expiryDisplay}, then switches to Free.`
                : 'Your subscription was cancelled (auto-renew turned off).',
              priority: 'medium',
              metadata: {
                provider: 'play',
                planId: resolvedPlanId,
                planVariantId: resolvedVariantId || null,
                productId,
                subscriptionId: purchaseToken,
                orderId: orderId || null,
                renewalDate: expiryIso,
                paymentState,
                source: 'play_reconcile',
              },
            }).catch(() => undefined);
          }
        }

        // Renewal detection: expiry changes and purchase is in good standing.
        const isNewRenewal = Boolean(expiryIso) && (orderId ? orderId !== lastRenewalOrderId : expiryIso !== lastRenewalExpiryIso);
        if (isNewRenewal && expiryIso) {
          if (!dryRun) {
            await billingRef.set(
              stripUndefinedDeep({
                planId: resolvedPlanId,
                planVariantId: resolvedVariantId || null,
                status: 'active',
                billingProvider: 'play',
                subscriptionId: purchaseToken,
                renewalDate: expiryIso,
                storeProductId: productId,
                ...(orderId ? { storeOrderId: orderId } : {}),
                ...(autoRenewing === true
                  ? {
                      cancelAtCycleEnd: admin.firestore.FieldValue.delete(),
                      scheduledDowngradePlanId: admin.firestore.FieldValue.delete(),
                      scheduledDowngradeAt: admin.firestore.FieldValue.delete(),
                    }
                  : {}),
                delinquentSince: admin.firestore.FieldValue.delete(),
                delinquentSinceIso: admin.firestore.FieldValue.delete(),
                lastStoreVerifyAtIso: nowIso,
                lastPaymentCapturedAt: admin.firestore.FieldValue.serverTimestamp(),
                lastPaymentCapturedAtIso: nowIso,
                lastPaymentCapturedPaymentId: orderId || null,
                lastPaymentCapturedSubscriptionId: purchaseToken,
                lastStoreRenewalNotifiedOrderId: orderId || null,
                lastStoreRenewalNotifiedExpiryIso: expiryIso,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              }),
              { merge: true }
            );

            await tenantRef.set(
              {
                billingTier: resolvedPlanId,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );

            // Invoice (best-effort)
            const invoiceId = orderId ? `play_${orderId}` : `play_${purchaseToken.slice(0, 12)}_${expiryIso}`;
            await db
              .collection('billingInvoices')
              .doc(tenantId)
              .collection('invoices')
              .doc(invoiceId)
              .set(
                stripUndefinedDeep({
                  amountInr: resolvedPriceInr,
                  status: 'paid',
                  provider: 'play',
                  issuedAt: nowIso,
                  planId: resolvedPlanId,
                  planVariantId: resolvedVariantId || null,
                  isSynthetic: true,
                  sourceEvent: 'play_reconcile_renewal',
                  providerSubscriptionId: purchaseToken,
                  subscriptionId: purchaseToken,
                  providerPaymentId: orderId || null,
                  rawEvent: 'play_reconcile',
                }),
                { merge: true }
              );
          }

          const bodyLines: string[] = [];
          bodyLines.push(`Payment received for the ${String(resolvedPlanId).toUpperCase()} plan.`);
          if (resolvedPriceInr > 0) bodyLines.push(`Amount: ₹${resolvedPriceInr}.`);
          if (expiryDisplay) bodyLines.push(`Next billing: ${expiryDisplay}.`);

          void sendTenantBillingEventNotification({
            tenantId,
            kind: 'subscription_charged',
            title: 'Subscription payment received',
            body: bodyLines.join('\n'),
            priority: 'medium',
            metadata: {
              provider: 'play',
              planId: resolvedPlanId,
              planVariantId: resolvedVariantId || null,
              productId,
              subscriptionId: purchaseToken,
              orderId: orderId || null,
              renewalDate: expiryIso,
              paymentState,
              source: 'play_reconcile',
            },
          }).catch(() => undefined);
        }
      } catch (error: any) {
        tenantErrors++;
        const status = typeof error?.status === 'number' ? error.status : null;
        const message = typeof error?.message === 'string' ? error.message : 'play_reconcile_tenant_failed';
        await recordBillingOpsEvent(db, {
          provider: 'play',
          type: 'play_reconcile_tenant_failed',
          severity: 'error',
          message,
          tenantId,
          httpStatus: status,
          requestPath: 'scheduler:play_billing_reconcile',
          subscriptionId: purchaseToken,
          metadata: { productId },
        });
      }
    }
  } finally {
    isRunning = false;
  }

  return {
    skippedBecauseAlreadyRunning: false,
    skippedBecauseLockNotAcquired: false,
    tenantsScanned,
    tenantErrors,
    configErrors: 0,
    lock: lockInfo as any,
  };
}
