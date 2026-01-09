import type * as admin from 'firebase-admin';
import { getPlanLimits, type PlanId, type PlanLimits } from './planLimits';
import { getPlanVariantById } from '../billing/catalog';

export interface TenantQuotaOverrides {
  maxStudents?: number | null;
  maxStaff?: number | null;
  maxMonthlyReminders?: number | null;
  maxMonthlyWhatsappReminders?: number | null;
  maxMonthlySmsReminders?: number | null;
  maxMonthlyEmailReminders?: number | null;
  maxMonthlyVoiceReminders?: number | null;
  maxStorageMb?: number | null;
}

function normalizePlanId(value: unknown): PlanId {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'pro' || normalized === 'enterprise') {
      return normalized;
    }
  }
  return 'free';
}

function coercePositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function coerceNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function mbToBytes(mb: number): number {
  return Math.round(mb * 1024 * 1024);
}

export type TenantBillingLimitsSnapshot = {
  staffSeats: number;
  students: number;
  reminders: {
    total: number;
    whatsapp: number;
    sms: number;
    voice: number;
    email: number;
  };
  storageBytes: number;
};

function coerceSnapshot(value: unknown): TenantBillingLimitsSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as any;
  const staffSeats = coerceNonNegativeNumber(v.staffSeats);
  const students = coerceNonNegativeNumber(v.students);
  const storageBytes = coerceNonNegativeNumber(v.storageBytes);
  const reminders = v.reminders && typeof v.reminders === 'object' ? v.reminders : null;
  const total = reminders ? coerceNonNegativeNumber((reminders as any).total) : null;
  const whatsapp = reminders ? coerceNonNegativeNumber((reminders as any).whatsapp) : null;
  const sms = reminders ? coerceNonNegativeNumber((reminders as any).sms) : null;
  const voice = reminders ? coerceNonNegativeNumber((reminders as any).voice) : null;
  const email = reminders ? coerceNonNegativeNumber((reminders as any).email) : null;

  if (
    staffSeats === null ||
    students === null ||
    storageBytes === null ||
    total === null ||
    whatsapp === null ||
    sms === null ||
    voice === null ||
    email === null
  ) {
    return null;
  }

  return {
    staffSeats,
    students,
    storageBytes,
    reminders: { total, whatsapp, sms, voice, email },
  };
}

export function toTenantBillingLimitsSnapshot(limits: PlanLimits): TenantBillingLimitsSnapshot {
  return {
    staffSeats: limits.staffSeats,
    students: limits.students,
    reminders: {
      total: limits.reminders.total,
      whatsapp: limits.reminders.whatsapp,
      sms: limits.reminders.sms,
      voice: limits.reminders.voice,
      email: limits.reminders.email,
    },
    storageBytes: limits.storageBytes,
  };
}

export async function resolvePlanLimitsFromCatalog(db: admin.firestore.Firestore, options: {
  planId: PlanId;
  planVariantId?: string | null;
}): Promise<PlanLimits> {
  const normalizedPlanId = options.planId === 'pro' || options.planId === 'enterprise' ? options.planId : 'free';
  const planVariantId =
    typeof options.planVariantId === 'string' && options.planVariantId.trim() ? options.planVariantId.trim() : null;

  let basePlanLimits = getPlanLimits(normalizedPlanId);

  if (planVariantId) {
    try {
      const variant = await getPlanVariantById(db, planVariantId);
      if (variant) {
        basePlanLimits = getPlanLimits(variant.planId);
        basePlanLimits = applyVariantLimitOverrides(basePlanLimits, variant);
        return basePlanLimits;
      }
    } catch {
      // ignore
    }
  }

  // Fall back to canonical variant id === planId.
  try {
    const canonicalVariant = await getPlanVariantById(db, basePlanLimits.id);
    if (canonicalVariant && canonicalVariant.planId === basePlanLimits.id) {
      basePlanLimits = applyVariantLimitOverrides(basePlanLimits, canonicalVariant);
    }
  } catch {
    // ignore
  }

  return basePlanLimits;
}

function applyVariantLimitOverrides(basePlanLimits: PlanLimits, variant: { limits?: any } | null): PlanLimits {
  const limits = variant?.limits;
  if (!limits || typeof limits !== 'object') {
    return basePlanLimits;
  }

  const staffSeats = coerceNonNegativeNumber(limits.staffSeats);
  const students = coerceNonNegativeNumber(limits.students);
  const remindersTotal = coerceNonNegativeNumber(limits.reminders?.total);
  const remindersWhatsapp = coerceNonNegativeNumber(limits.reminders?.whatsapp);
  const remindersSms = coerceNonNegativeNumber(limits.reminders?.sms);
  const remindersVoice = coerceNonNegativeNumber(limits.reminders?.voice);
  const remindersEmail = coerceNonNegativeNumber(limits.reminders?.email);
  const storageMb = coerceNonNegativeNumber(limits.storageMb);

  return {
    ...basePlanLimits,
    staffSeats: staffSeats ?? basePlanLimits.staffSeats,
    students: students ?? basePlanLimits.students,
    reminders: {
      ...basePlanLimits.reminders,
      total: remindersTotal ?? basePlanLimits.reminders.total,
      whatsapp: remindersWhatsapp ?? basePlanLimits.reminders.whatsapp,
      sms: remindersSms ?? basePlanLimits.reminders.sms,
      voice: remindersVoice ?? basePlanLimits.reminders.voice,
      email: remindersEmail ?? basePlanLimits.reminders.email,
    },
    storageBytes: typeof storageMb === 'number' ? mbToBytes(storageMb) : basePlanLimits.storageBytes,
  };
}

function applyBillingSnapshot(basePlanLimits: PlanLimits, snapshot: TenantBillingLimitsSnapshot): PlanLimits {
  return {
    ...basePlanLimits,
    staffSeats: snapshot.staffSeats,
    students: snapshot.students,
    reminders: {
      ...basePlanLimits.reminders,
      ...snapshot.reminders,
    },
    storageBytes: snapshot.storageBytes,
  };
}

function maxPlanLimits(a: PlanLimits, b: PlanLimits): PlanLimits {
  // Conservative: choose the higher (less restrictive) limit per dimension.
  // This is used to apply increases immediately while deferring decreases.
  return {
    ...a,
    staffSeats: Math.max(a.staffSeats, b.staffSeats),
    students: Math.max(a.students, b.students),
    reminders: {
      ...a.reminders,
      total: Math.max(a.reminders.total, b.reminders.total),
      whatsapp: Math.max(a.reminders.whatsapp, b.reminders.whatsapp),
      sms: Math.max(a.reminders.sms, b.reminders.sms),
      voice: Math.max(a.reminders.voice, b.reminders.voice),
      email: Math.max(a.reminders.email, b.reminders.email),
    },
    storageBytes: Math.max(a.storageBytes, b.storageBytes),
  };
}

function withCapacityLimits(base: PlanLimits, capacity: { staffSeats: number; students: number }): PlanLimits {
  return {
    ...base,
    staffSeats: capacity.staffSeats,
    students: capacity.students,
  };
}

function pickCapacityLimits(options: {
  resolvedPlanId: PlanId;
  applyChangesMode: 'immediate' | 'next_billing';
  decreasePolicy: 'soft' | 'hard';
  live: PlanLimits;
  snapshot: PlanLimits | null;
}): { staffSeats: number; students: number } {
  const { resolvedPlanId, applyChangesMode, decreasePolicy, live, snapshot } = options;

  if (resolvedPlanId === 'free') {
    return { staffSeats: live.staffSeats, students: live.students };
  }

  if (applyChangesMode === 'next_billing') {
    if (snapshot) {
      return { staffSeats: snapshot.staffSeats, students: snapshot.students };
    }
    return { staffSeats: live.staffSeats, students: live.students };
  }

  // immediate
  if (decreasePolicy === 'soft' && snapshot) {
    // Apply increases immediately but defer decreases until next billing snapshot.
    return {
      staffSeats: Math.max(live.staffSeats, snapshot.staffSeats),
      students: Math.max(live.students, snapshot.students),
    };
  }

  return { staffSeats: live.staffSeats, students: live.students };
}

export async function resolveEffectivePlanLimitsForTenant(
  db: admin.firestore.Firestore,
  tenantId: string,
  options: { billingTier?: string | null; quotas?: TenantQuotaOverrides | null } = {}
): Promise<PlanLimits> {
  const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (!normalizedTenantId) {
    return getPlanLimits('free');
  }

  let tenantBillingPlanId: PlanId | null = null;
  let planVariantId: string | null = null;
  let billingSnapshot: TenantBillingLimitsSnapshot | null = null;
  try {
    const billingSnap = await db.collection('tenantBilling').doc(normalizedTenantId).get();
    const billingData = billingSnap.exists ? billingSnap.data() || {} : {};
    tenantBillingPlanId = normalizePlanId((billingData as any).planId ?? (billingData as any).plan);
    planVariantId =
      typeof (billingData as any).planVariantId === 'string' && (billingData as any).planVariantId.trim()
        ? (billingData as any).planVariantId.trim()
        : null;
    billingSnapshot = coerceSnapshot((billingData as any).limitsSnapshot);
  } catch {
    tenantBillingPlanId = null;
    planVariantId = null;
    billingSnapshot = null;
  }

  const fallbackPlanId = normalizePlanId(options.billingTier);

  const resolvedPlanId = tenantBillingPlanId ?? fallbackPlanId;
  let basePlanLimits = getPlanLimits(resolvedPlanId);

  // Paid plan variants can optionally enforce catalog limit changes only from the next billing cycle.
  // In that mode, we prefer tenantBilling.limitsSnapshot (written at checkout/renewal).
  let applyChangesMode: 'immediate' | 'next_billing' = resolvedPlanId === 'free' ? 'immediate' : 'next_billing';
  let decreasePolicy: 'soft' | 'hard' = 'soft';
  try {
    const applyModeVariantId = planVariantId || resolvedPlanId;
    const variant = await getPlanVariantById(db, applyModeVariantId);
    if (variant && (variant.applyChangesMode === 'immediate' || variant.applyChangesMode === 'next_billing')) {
      applyChangesMode = variant.applyChangesMode;
    }
    if (variant && (variant.decreasePolicy === 'soft' || variant.decreasePolicy === 'hard')) {
      decreasePolicy = variant.decreasePolicy;
    }
  } catch {
    // ignore
  }

  const livePlanLimits = await resolvePlanLimitsFromCatalog(db, { planId: resolvedPlanId, planVariantId });

  // NOTE: We treat capacity limits (students/staff) differently from metered limits.
  // - Capacity (students/staff): can be soft-decreased (grandfathered) until renewal.
  // - Metered (reminders/storage): always hard-enforced against live catalog (ongoing cost).
  //
  // This matches the desired policy: safe plan edits without deleting data, but protect ongoing costs.
  const snapshotLimits = billingSnapshot ? applyBillingSnapshot(basePlanLimits, billingSnapshot) : null;
  const capacity = pickCapacityLimits({
    resolvedPlanId,
    applyChangesMode,
    decreasePolicy,
    live: livePlanLimits,
    snapshot: snapshotLimits,
  });

  // Base everything on live metered limits, then overwrite capacity as chosen above.
  basePlanLimits = withCapacityLimits(livePlanLimits, capacity);

  const quotas = options.quotas || undefined;
  if (!quotas) {
    return basePlanLimits;
  }

  const maxStaff = coercePositiveNumber(quotas.maxStaff);
  const maxStudents = coercePositiveNumber(quotas.maxStudents);
  const maxMonthlyReminders = coercePositiveNumber(quotas.maxMonthlyReminders);
  const maxMonthlyWhatsappReminders = coercePositiveNumber(quotas.maxMonthlyWhatsappReminders);
  const maxMonthlySmsReminders = coercePositiveNumber(quotas.maxMonthlySmsReminders);
  const maxMonthlyEmailReminders = coercePositiveNumber(quotas.maxMonthlyEmailReminders);
  const maxMonthlyVoiceReminders = coercePositiveNumber(quotas.maxMonthlyVoiceReminders);
  const maxStorageMb = coercePositiveNumber(quotas.maxStorageMb);

  return {
    ...basePlanLimits,
    staffSeats: maxStaff ?? basePlanLimits.staffSeats,
    students: maxStudents ?? basePlanLimits.students,
    reminders: {
      ...basePlanLimits.reminders,
      total: maxMonthlyReminders ?? basePlanLimits.reminders.total,
      whatsapp: maxMonthlyWhatsappReminders ?? basePlanLimits.reminders.whatsapp,
      sms: maxMonthlySmsReminders ?? basePlanLimits.reminders.sms,
      email: maxMonthlyEmailReminders ?? basePlanLimits.reminders.email,
      voice: maxMonthlyVoiceReminders ?? basePlanLimits.reminders.voice,
    },
    storageBytes: typeof maxStorageMb === 'number' ? mbToBytes(maxStorageMb) : basePlanLimits.storageBytes,
  };
}
