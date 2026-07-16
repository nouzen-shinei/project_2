import * as admin from 'firebase-admin';

export type ReminderChannel = 'email' | 'sms' | 'whatsapp' | 'voice';
export type ReminderFinalStatus = 'success' | 'failed';

export function normalizeMonthIdUtc(date: Date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function isBillableReminderStatus(status: unknown): boolean {
  return status === 'success';
}

export function isFinalReminderStatus(status: unknown): status is ReminderFinalStatus {
  return status === 'success' || status === 'failed';
}

export function coerceReminderChannel(value: unknown): ReminderChannel | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (raw === 'email' || raw === 'sms' || raw === 'whatsapp' || raw === 'voice') {
    return raw;
  }
  return null;
}

function safeNumber(value: unknown): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return n >= 0 ? n : 0;
}

function clampDecrement(current: number, dec: number): number {
  if (dec <= 0) return current;
  return Math.max(0, current - dec);
}

/**
 * Finalizes reminder quota for a specific reminder history record.
 *
 * Expected flow:
 * - When a reminder attempt is created/queued, the caller sets `reminderHistory.quota.inFlight=true`
 *   and increments `tenantReminderUsage.inFlight*` counters.
 * - When a reminder reaches a final status (success/failed), call this function.
 *   It will:
 *   - decrement inFlight counters once (idempotent via `quota.inFlight`)
 *   - increment billable counters once on success (idempotent via `quota.billed`)
 *
 * If quota metadata is missing on the history document, this still increments billable usage on success
 * (best-effort), but cannot safely decrement in-flight.
 */
export async function finalizeReminderQuotaFromHistory(
  db: admin.firestore.Firestore,
  options: {
    historyId: string;
    finalStatus: ReminderFinalStatus;
    fallbackTenantId?: string;
    fallbackChannel?: ReminderChannel;
    fallbackMonthId?: string;
    // When set, refuse to finalize (and never touch quota counters) if the
    // reminderHistory doc resolves to a DIFFERENT tenant than expected. Guards
    // against a spoofed historyId pointing at another tenant's record
    // (security-rules-hardening L13).
    expectedTenantId?: string;
  }
): Promise<void> {
  const historyId = typeof options.historyId === 'string' ? options.historyId.trim() : '';
  if (!historyId) return;

  const historyRef = db.collection('reminderHistory').doc(historyId);

  await db.runTransaction(async (tx) => {
    const historySnap = await tx.get(historyRef);
    if (!historySnap.exists) {
      return;
    }

    const history = historySnap.data() || {};
    const quota = (history as any).quota && typeof (history as any).quota === 'object' ? (history as any).quota : null;

    const tenantIdFromHistory = typeof (history as any).tenantId === 'string' ? (history as any).tenantId.trim() : '';
    const tenantIdFromQuota = typeof quota?.tenantId === 'string' ? String(quota.tenantId).trim() : '';
    const tenantId = tenantIdFromHistory || tenantIdFromQuota || (options.fallbackTenantId || '').trim();
    if (!tenantId) {
      return;
    }

    // L13: if the caller told us which tenant this finalize is for, never mutate a
    // different tenant's quota — the history doc belongs to someone else (spoofed id).
    const expectedTenantId = (options.expectedTenantId || '').trim();
    if (expectedTenantId && tenantId !== expectedTenantId) {
      return;
    }

    const channelFromHistory = coerceReminderChannel((history as any).reminderType);
    const channelFromQuota = coerceReminderChannel(quota?.channel);
    const channel = channelFromQuota || channelFromHistory || options.fallbackChannel || null;
    if (!channel) {
      return;
    }

    const monthFromQuota = typeof quota?.monthId === 'string' ? String(quota.monthId).trim() : '';
    const createdAt = (history as any).createdAt;
    const monthFromCreatedAt = createdAt instanceof admin.firestore.Timestamp
      ? normalizeMonthIdUtc(createdAt.toDate())
      : '';
    const monthId = monthFromQuota || monthFromCreatedAt || options.fallbackMonthId || normalizeMonthIdUtc();

    const usageRef = db.collection('tenantReminderUsage').doc(tenantId).collection('months').doc(monthId);
    const usageSnap = await tx.get(usageRef);
    const usage = usageSnap.exists ? usageSnap.data() || {} : {};

    const quotaInFlight = quota?.inFlight === true;
    const quotaBilled = quota?.billed === true;

    const updates: Record<string, unknown> = {
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    let nextInFlightTotal = safeNumber((usage as any).inFlightTotal);
    let nextInFlightChannel = safeNumber((usage as any)[`inFlight${channel[0].toUpperCase()}${channel.slice(1)}`]);

    // Release inFlight slot once.
    if (quotaInFlight) {
      nextInFlightTotal = clampDecrement(nextInFlightTotal, 1);
      nextInFlightChannel = clampDecrement(nextInFlightChannel, 1);
      updates.inFlightTotal = nextInFlightTotal;
      updates[`inFlight${channel[0].toUpperCase()}${channel.slice(1)}`] = nextInFlightChannel;
    }

    // Bill once on success.
    if (options.finalStatus === 'success' && !quotaBilled) {
      const currentTotal = safeNumber((usage as any).total);
      const currentChannel = safeNumber((usage as any)[channel]);
      updates.total = currentTotal + 1;
      updates[channel] = currentChannel + 1;
    }

    // If we have neither quota metadata nor anything to update, bail.
    const hasUsageChange = Object.keys(updates).some((k) => k !== 'updatedAt');
    if (hasUsageChange) {
      if (!usageSnap.exists) {
        updates.tenantId = tenantId;
        updates.month = monthId;
        updates.createdAt = admin.firestore.FieldValue.serverTimestamp();
      }
      tx.set(usageRef, updates, { merge: true });
    }

    // Update quota state on history (idempotency + observability).
    const nextQuota = stripUndefined({
      ...(quota && typeof quota === 'object' ? quota : {}),
      tenantId,
      channel,
      monthId,
      inFlight: quotaInFlight ? false : quota?.inFlight,
      billed: options.finalStatus === 'success' ? true : quota?.billed,
      finalizedAt: admin.firestore.FieldValue.serverTimestamp(),
      finalStatus: options.finalStatus,
    });

    tx.set(
      historyRef,
      {
        quota: nextQuota,
        quotaFinalizedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  const out: any = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}
