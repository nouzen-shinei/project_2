import type * as admin from 'firebase-admin';
import type { PlanId } from '../lib/planLimits';

export type BillingInterval = 'month';

export type BillingPlanVariantApplyChangesMode = 'immediate' | 'next_billing';
export type BillingPlanVariantDecreasePolicy = 'soft' | 'hard';

export interface BillingPlanVariantLimits {
  staffSeats?: number;
  students?: number;
  reminders?: {
    total?: number;
    whatsapp?: number;
    sms?: number;
    voice?: number;
    email?: number;
  };
  storageMb?: number;
}

export interface BillingPlanVariant {
  id: string;
  planId: PlanId;
  displayName: string;
  currency: 'INR';
  priceInr: number;
  interval: BillingInterval;
  provider: 'razorpay';
  razorpayPlanId?: string;
  // Optional: Google Play subscription/product id used for Android store billing.
  // This does NOT affect the Razorpay checkout provider; it only enables /billing/play/verify.
  playProductId?: string;
  limits?: BillingPlanVariantLimits;
  applyChangesMode?: BillingPlanVariantApplyChangesMode;
  decreasePolicy?: BillingPlanVariantDecreasePolicy;
  active: boolean;
  sortOrder: number;
  updatedAt?: string;
  createdAt?: string;
}

export interface BillingCoupon {
  id: string;
  code: string;
  mapsToPlanVariantId: string;
  active: boolean;
  startsAt?: string;
  endsAt?: string;
  updatedAt?: string;
  createdAt?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stripUndefinedDeep<T>(value: T): T {
  if (value === undefined) return value;
  if (value === null) return value;
  if (Array.isArray(value)) {
    // Firestore does not allow `undefined` in arrays.
    return value
      .map((entry) => stripUndefinedDeep(entry))
      .filter((entry) => entry !== undefined) as unknown as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const cleaned = stripUndefinedDeep(entry);
    if (cleaned === undefined) continue;
    out[key] = cleaned;
  }
  return out as T;
}

function normalizeCouponCode(value: string): string {
  return value.trim().toUpperCase();
}

export function builtInFreePlan(): BillingPlanVariant {
  return {
    id: 'free',
    planId: 'free',
    displayName: 'Free',
    currency: 'INR',
    priceInr: 0,
    interval: 'month',
    provider: 'razorpay',
    applyChangesMode: 'immediate',
    decreasePolicy: 'soft',
    active: true,
    sortOrder: 0,
  };
}

export function builtInEnterpriseCustomPlan(): BillingPlanVariant {
  return {
    id: 'enterprise_custom',
    planId: 'enterprise',
    displayName: 'Custom (Enterprise)',
    currency: 'INR',
    // This variant is meant for operator-assigned, custom-priced plans.
    // Do not rely on this value for checkout.
    priceInr: 0,
    interval: 'month',
    provider: 'razorpay',
    applyChangesMode: 'immediate',
    decreasePolicy: 'soft',
    active: true,
    sortOrder: 10_000,
  };
}

function env(name: string): string {
  return (process.env[name] || '').trim();
}

// Note: We intentionally do NOT provide any hard-coded paid plan variants here.
// All paid variants (names + prices) must be created/edited via the Admin Console.

export async function listPlanVariants(db: admin.firestore.Firestore, options?: { includeInactive?: boolean }) {
  const includeInactive = options?.includeInactive === true;
  // We intentionally avoid composite-index queries (e.g. where('active','==',true).orderBy('sortOrder'))
  // because they can 500 in new Firestore projects unless the index is manually created.
  // The catalog is small, so we read all and filter/sort in memory.
  const snap = await db.collection('billingPlanVariants').get();
  const plans = snap.docs
    .map((doc) => {
      const data = (doc.data() || {}) as Partial<BillingPlanVariant>;
      const limitsRaw = (data as any).limits;
      const remindersRaw = limitsRaw && typeof limitsRaw === 'object' ? (limitsRaw as any).reminders : undefined;
      const planId = data.planId === 'pro' || data.planId === 'enterprise' ? data.planId : 'free';
      const applyChangesModeRaw = (data as any).applyChangesMode;
      const decreasePolicyRaw = (data as any).decreasePolicy;
      const applyChangesMode: BillingPlanVariantApplyChangesMode | undefined =
        applyChangesModeRaw === 'immediate' || applyChangesModeRaw === 'next_billing' ? applyChangesModeRaw : undefined;
      const decreasePolicy: BillingPlanVariantDecreasePolicy | undefined =
        decreasePolicyRaw === 'soft' || decreasePolicyRaw === 'hard' ? decreasePolicyRaw : undefined;
      return {
        id: doc.id,
        planId,
        displayName: String(data.displayName || ''),
        currency: 'INR' as const,
        priceInr: Number.isFinite(data.priceInr) ? Number(data.priceInr) : 0,
        interval: 'month' as const,
        provider: 'razorpay' as const,
        razorpayPlanId: typeof data.razorpayPlanId === 'string' && data.razorpayPlanId.trim() ? data.razorpayPlanId.trim() : undefined,
        playProductId: typeof (data as any).playProductId === 'string' && (data as any).playProductId.trim() ? (data as any).playProductId.trim() : undefined,
        applyChangesMode,
        decreasePolicy,
        limits:
          limitsRaw && typeof limitsRaw === 'object'
            ? {
                staffSeats: Number.isFinite((limitsRaw as any).staffSeats) ? Number((limitsRaw as any).staffSeats) : undefined,
                students: Number.isFinite((limitsRaw as any).students) ? Number((limitsRaw as any).students) : undefined,
                storageMb: Number.isFinite((limitsRaw as any).storageMb) ? Number((limitsRaw as any).storageMb) : undefined,
                reminders:
                  remindersRaw && typeof remindersRaw === 'object'
                    ? {
                        total: Number.isFinite((remindersRaw as any).total) ? Number((remindersRaw as any).total) : undefined,
                        whatsapp: Number.isFinite((remindersRaw as any).whatsapp) ? Number((remindersRaw as any).whatsapp) : undefined,
                        sms: Number.isFinite((remindersRaw as any).sms) ? Number((remindersRaw as any).sms) : undefined,
                        voice: Number.isFinite((remindersRaw as any).voice) ? Number((remindersRaw as any).voice) : undefined,
                        email: Number.isFinite((remindersRaw as any).email) ? Number((remindersRaw as any).email) : undefined,
                      }
                    : undefined,
              }
            : undefined,
        active: Boolean(data.active),
        sortOrder: Number.isFinite(data.sortOrder) ? Number(data.sortOrder) : 100,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
      } satisfies BillingPlanVariant;
    })
    .filter((entry) => entry.id && entry.displayName)
    .filter((entry) => (includeInactive ? true : entry.active))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  return plans;
}

function parsePlanVariantSnapshot(
  doc: admin.firestore.DocumentSnapshot<admin.firestore.DocumentData>
): BillingPlanVariant | null {
  if (!doc.exists) {
    return null;
  }
  const data = (doc.data() || {}) as Partial<BillingPlanVariant>;
  const limitsRaw = (data as any).limits;
  const remindersRaw = limitsRaw && typeof limitsRaw === 'object' ? (limitsRaw as any).reminders : undefined;
  const planId = data.planId === 'pro' || data.planId === 'enterprise' ? data.planId : 'free';
  const applyChangesModeRaw = (data as any).applyChangesMode;
  const decreasePolicyRaw = (data as any).decreasePolicy;
  const applyChangesMode: BillingPlanVariantApplyChangesMode | undefined =
    applyChangesModeRaw === 'immediate' || applyChangesModeRaw === 'next_billing' ? applyChangesModeRaw : undefined;
  const decreasePolicy: BillingPlanVariantDecreasePolicy | undefined =
    decreasePolicyRaw === 'soft' || decreasePolicyRaw === 'hard' ? decreasePolicyRaw : undefined;
  const displayName = String(data.displayName || '');
  if (!doc.id || !displayName) {
    return null;
  }

  return {
    id: doc.id,
    planId,
    displayName,
    currency: 'INR' as const,
    priceInr: Number.isFinite(data.priceInr) ? Number(data.priceInr) : 0,
    interval: 'month' as const,
    provider: 'razorpay' as const,
    razorpayPlanId:
      typeof data.razorpayPlanId === 'string' && data.razorpayPlanId.trim() ? data.razorpayPlanId.trim() : undefined,
    playProductId:
      typeof (data as any).playProductId === 'string' && (data as any).playProductId.trim() ? (data as any).playProductId.trim() : undefined,
    applyChangesMode,
    decreasePolicy,
    limits:
      limitsRaw && typeof limitsRaw === 'object'
        ? {
            staffSeats: Number.isFinite((limitsRaw as any).staffSeats) ? Number((limitsRaw as any).staffSeats) : undefined,
            students: Number.isFinite((limitsRaw as any).students) ? Number((limitsRaw as any).students) : undefined,
            storageMb: Number.isFinite((limitsRaw as any).storageMb) ? Number((limitsRaw as any).storageMb) : undefined,
            reminders:
              remindersRaw && typeof remindersRaw === 'object'
                ? {
                    total: Number.isFinite((remindersRaw as any).total) ? Number((remindersRaw as any).total) : undefined,
                    whatsapp: Number.isFinite((remindersRaw as any).whatsapp)
                      ? Number((remindersRaw as any).whatsapp)
                      : undefined,
                    sms: Number.isFinite((remindersRaw as any).sms) ? Number((remindersRaw as any).sms) : undefined,
                    voice: Number.isFinite((remindersRaw as any).voice) ? Number((remindersRaw as any).voice) : undefined,
                    email: Number.isFinite((remindersRaw as any).email) ? Number((remindersRaw as any).email) : undefined,
                  }
                : undefined,
          }
        : undefined,
    active: Boolean(data.active),
    sortOrder: Number.isFinite(data.sortOrder) ? Number(data.sortOrder) : 100,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
  } satisfies BillingPlanVariant;
}

export async function getPlanVariantById(
  db: admin.firestore.Firestore,
  planVariantId: string
): Promise<BillingPlanVariant | null> {
  const id = typeof planVariantId === 'string' ? planVariantId.trim() : '';
  if (!id) {
    return null;
  }
  const snap = await db.collection('billingPlanVariants').doc(id).get();
  const parsed = parsePlanVariantSnapshot(snap);
  if (parsed) {
    return parsed;
  }
  if (id === 'free') {
    return builtInFreePlan();
  }
  if (id === 'enterprise_custom') {
    return builtInEnterpriseCustomPlan();
  }
  return null;
}

export async function upsertPlanVariant(
  db: admin.firestore.Firestore,
  input: Omit<BillingPlanVariant, 'updatedAt' | 'createdAt'>
) {
  const ref = db.collection('billingPlanVariants').doc(input.id);
  const existing = await ref.get();
  const createdAt = existing.exists ? undefined : nowIso();
  const { razorpayPlanId, playProductId, ...rest } = input;
  const normalizedRazorpayPlanId = typeof razorpayPlanId === 'string' ? razorpayPlanId.trim() : '';
  const normalizedPlayProductId = typeof playProductId === 'string' ? playProductId.trim() : '';
  const record: Partial<BillingPlanVariant> = {
    ...rest,
    ...(normalizedRazorpayPlanId ? { razorpayPlanId: normalizedRazorpayPlanId } : {}),
    ...(normalizedPlayProductId ? { playProductId: normalizedPlayProductId } : {}),
    updatedAt: nowIso(),
    ...(createdAt ? { createdAt } : {}),
  };
  await ref.set(stripUndefinedDeep(record), { merge: true });
}

export async function listCoupons(db: admin.firestore.Firestore, options?: { includeInactive?: boolean }) {
  const includeInactive = options?.includeInactive === true;
  // Avoid composite-index query requirements for the same reason as listPlanVariants().
  const snap = await db.collection('billingCoupons').get();
  const coupons = snap.docs
    .map((doc) => {
      const data = (doc.data() || {}) as Partial<BillingCoupon>;
      const code = typeof data.code === 'string' ? normalizeCouponCode(data.code) : normalizeCouponCode(doc.id);
      return {
        id: doc.id,
        code,
        mapsToPlanVariantId: String(data.mapsToPlanVariantId || ''),
        active: Boolean(data.active),
        startsAt: typeof data.startsAt === 'string' ? data.startsAt : undefined,
        endsAt: typeof data.endsAt === 'string' ? data.endsAt : undefined,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : undefined,
      } satisfies BillingCoupon;
    })
    .filter((entry) => entry.id && entry.code && entry.mapsToPlanVariantId)
    .filter((entry) => (includeInactive ? true : entry.active))
    .sort((a, b) => a.code.localeCompare(b.code));

  return coupons;
}

export async function upsertCoupon(db: admin.firestore.Firestore, input: Omit<BillingCoupon, 'updatedAt' | 'createdAt'>) {
  const id = input.id.trim();
  const ref = db.collection('billingCoupons').doc(id);
  const existing = await ref.get();
  const createdAt = existing.exists ? undefined : nowIso();
  const record: Partial<BillingCoupon> = {
    ...input,
    code: normalizeCouponCode(input.code),
    mapsToPlanVariantId: input.mapsToPlanVariantId.trim(),
    updatedAt: nowIso(),
    ...(createdAt ? { createdAt } : {}),
  };
  await ref.set(stripUndefinedDeep(record), { merge: true });
}

export function isCouponActiveNow(coupon: BillingCoupon, now: Date = new Date()): boolean {
  if (!coupon.active) return false;
  const nowMs = now.getTime();
  const startsMs = coupon.startsAt ? Date.parse(coupon.startsAt) : NaN;
  const endsMs = coupon.endsAt ? Date.parse(coupon.endsAt) : NaN;
  if (Number.isFinite(startsMs) && nowMs < startsMs) return false;
  if (Number.isFinite(endsMs) && nowMs > endsMs) return false;
  return true;
}

export function resolveCouponCode(coupons: BillingCoupon[], codeRaw?: string | null): BillingCoupon | null {
  const code = typeof codeRaw === 'string' ? normalizeCouponCode(codeRaw) : '';
  if (!code) return null;
  const found = coupons.find((entry) => normalizeCouponCode(entry.code) === code) ?? null;
  if (!found) return null;
  return isCouponActiveNow(found) ? found : null;
}
