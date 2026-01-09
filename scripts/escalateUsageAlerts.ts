#!/usr/bin/env ts-node
import 'dotenv/config';
import * as admin from 'firebase-admin';
import { initFirebase } from '../backend-runtime/src/jobs/tenantUsageRollup';
import { buildMetricCopy, sendSlackNotification } from '../backend-runtime/src/usageAlertNotifier';
import type { UsageMetricKey } from '../backend-runtime/src/lib/usageMetrics';

const DEFAULT_BATCH_LIMIT = 20;
const DEFAULT_MAX_ATTEMPTS = 3;
const batchLimit = Number(process.env.USAGE_ALERT_ESCALATION_BATCH_LIMIT) || DEFAULT_BATCH_LIMIT;
const maxAttempts = Number(process.env.USAGE_ALERT_ESCALATION_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS;
const slackWebhook = (process.env.USAGE_ALERT_SLACK_WEBHOOK_URL || '').trim();
const ESCALATION_SUPPRESSED_AT = '9999-12-31T23:59:59.999Z';

interface AlertDocData {
  metric?: UsageMetricKey;
  type?: 'warning' | 'critical';
  value?: number;
  limit?: number;
  ratio?: number;
  notifications?: {
    ack?: Record<string, any>;
  };
}

initFirebase();
const db = admin.firestore();

function parseAlertPath(path: string): { tenantId: string; monthId: string; alertId: string } | null {
  const segments = path.split('/');
  if (segments.length !== 6) {
    return null;
  }
  const [collection, tenantId, monthsCollection, monthId, alertsCollection, alertId] = segments;
  if (collection !== 'tenantUsage' || monthsCollection !== 'months' || alertsCollection !== 'alerts') {
    return null;
  }
  return { tenantId, monthId, alertId };
}

function shouldSkipSlack(ack: Record<string, any> | undefined): boolean {
  if (!ack) {
    return true;
  }
  if (ack.channelPreferences && ack.channelPreferences.slack === false) {
    return true;
  }
  return false;
}

async function capEscalation(docRef: admin.firestore.DocumentReference, extra: Record<string, unknown> = {}): Promise<void> {
  await docRef.set(
    {
      'notifications.ack.escalationLimitReached': true,
      'notifications.ack.escalateAt': ESCALATION_SUPPRESSED_AT,
      ...extra,
    },
    { merge: true }
  );
}

async function loadTenantName(tenantId: string): Promise<string | undefined> {
  try {
    const snap = await db.collection('tenants').doc(tenantId).get();
    if (!snap.exists) {
      return undefined;
    }
    const data = snap.data() || {};
    if (typeof data.name === 'string' && data.name.trim()) {
      return data.name.trim();
    }
    if (typeof data.coachingName === 'string' && data.coachingName.trim()) {
      return data.coachingName.trim();
    }
    return undefined;
  } catch (error) {
    console.warn('[usage_alert_escalation] failed to load tenant name', { tenantId, error });
    return undefined;
  }
}

async function processAlert(doc: admin.firestore.QueryDocumentSnapshot<admin.firestore.DocumentData>): Promise<'sent' | 'skipped'> {
  const pathInfo = parseAlertPath(doc.ref.path);
  if (!pathInfo) {
    console.warn('[usage_alert_escalation] unknown alert path structure', { path: doc.ref.path });
    return 'skipped';
  }

  const data = doc.data() as AlertDocData;
  const ack = data.notifications?.ack;
  if (!ack) {
    console.warn('[usage_alert_escalation] alert missing ack metadata', { id: doc.id });
    return 'skipped';
  }
  if (shouldSkipSlack(ack)) {
    await capEscalation(doc.ref, { 'notifications.ack.escalationReason': 'slack_disabled' });
    return 'skipped';
  }

  const escalationCount = typeof ack.escalationCount === 'number' ? ack.escalationCount : 0;
  if (escalationCount >= maxAttempts) {
    await capEscalation(doc.ref, {
      'notifications.ack.escalationReason': 'max_attempts',
    });
    return 'skipped';
  }

  const severity = (data.type || ack.threshold || 'warning') === 'critical' ? 'critical' : 'warning';
  const severityLabel = severity === 'critical' ? 'Critical' : 'Warning';
  const metric = data.metric || ack.metric || 'reminders';
  const metricLabel = ack.metricLabel || metric;
  const monthId = ack.monthId || pathInfo.monthId;
  const ackUrl = typeof ack.ackUrl === 'string' ? ack.ackUrl : undefined;
  const percentage = typeof ack.percentage === 'number' ? ack.percentage : Math.round((data.ratio || 0) * 100);
  const value = typeof data.value === 'number' ? data.value : 0;
  const limit = typeof data.limit === 'number' ? data.limit : 1;
  const { valueLabel, limitLabel } = ack.valueLabel && ack.limitLabel ? { valueLabel: ack.valueLabel, limitLabel: ack.limitLabel } : buildMetricCopy(metric, value, limit);
  const tenantName = ack.tenantName || (await loadTenantName(pathInfo.tenantId));

  const slackResult = await sendSlackNotification(slackWebhook, {
    tenantId: pathInfo.tenantId,
    tenantName,
    severityLabel: `${severityLabel} (Escalation)`,
    metricLabel,
    percentage,
    valueLabel,
    limitLabel,
    monthId,
    ackUrl,
  });

  const now = new Date();
  const nowIso = now.toISOString();
  const updates: Record<string, unknown> = {
    'notifications.ack.lastEscalatedAt': nowIso,
    'notifications.ack.lastEscalatedAtTimestamp': admin.firestore.FieldValue.serverTimestamp(),
    'notifications.ack.lastEscalationStatus': slackResult?.ok ? 'sent' : 'failed',
    'notifications.ack.lastEscalationSummary': slackResult ?? null,
    'notifications.ack.escalationCount': escalationCount + 1,
    'notifications.ack.lastEscalationError': slackResult?.ok ? admin.firestore.FieldValue.delete() : slackResult?.error || `status:${slackResult?.status ?? 'unknown'}`,
  };

  const nextCount = escalationCount + 1;
  if (nextCount >= maxAttempts) {
    updates['notifications.ack.escalationLimitReached'] = true;
    updates['notifications.ack.escalationReason'] = 'max_attempts';
    updates['notifications.ack.escalateAt'] = ESCALATION_SUPPRESSED_AT;
  } else {
    const intervalHours = typeof ack.escalateAfterHours === 'number' && ack.escalateAfterHours > 0 ? ack.escalateAfterHours : severity === 'critical' ? 6 : 24;
    const nextEscalateAtDate = new Date(now.getTime() + intervalHours * 60 * 60 * 1000);
    updates['notifications.ack.escalateAt'] = nextEscalateAtDate.toISOString();
    updates['notifications.ack.escalateAtTimestamp'] = admin.firestore.Timestamp.fromDate(nextEscalateAtDate);
  }

  await doc.ref.set(updates, { merge: true });
  return slackResult?.ok ? 'sent' : 'skipped';
}

async function main(): Promise<void> {
  if (!slackWebhook) {
    console.warn('[usage_alert_escalation] USAGE_ALERT_SLACK_WEBHOOK_URL missing, skipping run');
    return;
  }

  const nowIso = new Date().toISOString();
  const snapshot = await db
    .collectionGroup('alerts')
    .where('notifications.ack.pending', '==', true)
    .where('notifications.ack.escalateAt', '<=', nowIso)
    .orderBy('notifications.ack.escalateAt', 'asc')
    .limit(batchLimit)
    .get();

  if (snapshot.empty) {
    console.log('[usage_alert_escalation] no alerts ready for escalation');
    return;
  }

  console.log('[usage_alert_escalation] processing alerts', { count: snapshot.size, batchLimit, maxAttempts });
  let sent = 0;
  let skipped = 0;

  for (const doc of snapshot.docs) {
    try {
      const result = await processAlert(doc);
      if (result === 'sent') {
        sent += 1;
      } else {
        skipped += 1;
      }
    } catch (error) {
      console.error('[usage_alert_escalation] alert escalation failed', { path: doc.ref.path, error });
      skipped += 1;
    }
  }

  console.log('[usage_alert_escalation] batch complete', { sent, skipped });
}

main().catch((error) => {
  console.error('[usage_alert_escalation] fatal error', error);
  process.exitCode = 1;
});
