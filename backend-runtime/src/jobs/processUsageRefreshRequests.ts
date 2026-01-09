import 'dotenv/config';
import * as admin from 'firebase-admin';
import { initFirebase, runTenantUsageRollup, shutdownFirebase } from './tenantUsageRollup';
import { stripUndefinedDeep } from '../lib/stripUndefinedDeep';

const DEFAULT_BATCH_LIMIT = 3;
const batchLimit = Number(process.env.USAGE_REFRESH_BATCH_LIMIT) || DEFAULT_BATCH_LIMIT;
const dryRun = process.env.USAGE_REFRESH_DRY_RUN === '1';
const verbose = process.env.USAGE_REFRESH_VERBOSE === '1';

interface RefreshRequestRecord {
  tenantId?: string;
  month?: string;
  status?: string;
  requestedAt?: admin.firestore.Timestamp;
  attempts?: number;
}

async function ensureFirestore(): Promise<admin.firestore.Firestore> {
  initFirebase();
  return admin.firestore();
}

async function claimRequest(
  db: admin.firestore.Firestore,
  doc: admin.firestore.QueryDocumentSnapshot<admin.firestore.DocumentData>
): Promise<RefreshRequestRecord | null> {
  const docRef = doc.ref;
  return db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(docRef);
    if (!freshSnap.exists) {
      return null;
    }
    const data = freshSnap.data() as RefreshRequestRecord;
    if ((data.status ?? 'pending') !== 'pending') {
      return null;
    }
    tx.update(docRef, {
      status: 'processing',
      processingStartedAt: admin.firestore.FieldValue.serverTimestamp(),
      attempts: admin.firestore.FieldValue.increment(1),
      lastError: admin.firestore.FieldValue.delete(),
    });
    return data;
  });
}

async function markCompleted(
  docRef: admin.firestore.DocumentReference,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await docRef.update(
    stripUndefinedDeep({
      status: 'completed',
      completedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastRunDryRun: dryRun,
      lastMessage: (extra as any)?.message ?? 'Usage rollup queued successfully.',
      lastError: admin.firestore.FieldValue.delete(),
      ...extra,
    })
  );
}

async function markFailed(
  docRef: admin.firestore.DocumentReference,
  error: unknown
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await docRef.update(
    stripUndefinedDeep({
      status: 'failed',
      failureAt: admin.firestore.FieldValue.serverTimestamp(),
      lastError: message,
    })
  );
}

async function processRequest(
  db: admin.firestore.Firestore,
  doc: admin.firestore.QueryDocumentSnapshot<admin.firestore.DocumentData>
): Promise<'success' | 'skipped' | 'failed'> {
  const lockedData = await claimRequest(db, doc);
  if (!lockedData) {
    console.log('[usage_refresh_worker] request already handled', { id: doc.id });
    return 'skipped';
  }

  const tenantId = lockedData.tenantId?.trim();
  if (!tenantId) {
    await markFailed(doc.ref, new Error('tenantId missing on refresh request'));
    return 'failed';
  }
  const month = typeof lockedData.month === 'string' ? lockedData.month : undefined;

  console.log('[usage_refresh_worker] processing request', {
    id: doc.id,
    tenantId,
    month,
    dryRun,
  });

  try {
    await runTenantUsageRollup({
      tenantId,
      month,
      backfill: 0,
      dryRun,
      verbose,
    });
    await markCompleted(doc.ref);
    console.log('[usage_refresh_worker] request completed', { id: doc.id, tenantId });
    return 'success';
  } catch (error) {
    console.error('[usage_refresh_worker] request failed', { id: doc.id, tenantId, error });
    await markFailed(doc.ref, error);
    return 'failed';
  }
}

async function main(): Promise<void> {
  const db = await ensureFirestore();
  const collection = db.collection('tenantUsageRefreshRequests');
  let snapshot: admin.firestore.QuerySnapshot<admin.firestore.DocumentData>;
  try {
    // Prefer oldest-first processing when the composite index exists.
    snapshot = await collection
      .where('status', '==', 'pending')
      .orderBy('requestedAt', 'asc')
      .limit(batchLimit)
      .get();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const looksLikeMissingIndex = /requires an index/i.test(message) || /FAILED_PRECONDITION/i.test(message);
    if (!looksLikeMissingIndex) {
      throw error;
    }

    // Fallback: avoid composite-index requirement (status + requestedAt).
    console.warn('[usage_refresh_worker] ordered query failed; retrying without orderBy (missing index?)', {
      message,
    });
    snapshot = await collection.where('status', '==', 'pending').limit(batchLimit).get();
  }

  if (snapshot.empty) {
    console.log('[usage_refresh_worker] no pending usage refresh requests');
    return;
  }

  console.log('[usage_refresh_worker] processing batch', { count: snapshot.size, dryRun, verbose });
  let failures = 0;
  let successes = 0;
  let skipped = 0;

  for (const doc of snapshot.docs) {
    const result = await processRequest(db, doc);
    if (result === 'success') {
      successes += 1;
    } else if (result === 'failed') {
      failures += 1;
    } else {
      skipped += 1;
    }
  }

  console.log('[usage_refresh_worker] batch complete', { successes, failures, skipped });
  if (failures > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error('[usage_refresh_worker] fatal error', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await shutdownFirebase();
  });
