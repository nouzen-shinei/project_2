export type PlanId = 'free' | 'pro' | 'enterprise';

export interface ReminderLimits {
  total: number;
  whatsapp: number;
  sms: number;
  voice: number;
  email: number;
}

export interface PlanLimits {
  id: PlanId;
  label: string;
  monthlyPriceInr: number | null;
  staffSeats: number;
  students: number;
  reminders: ReminderLimits;
  storageBytes: number;
  chatMessages: number;
  noticePosts: number;
  warningThreshold: number;
  criticalThreshold: number;
}

const GB = 1024 * 1024 * 1024;

export const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    id: 'free',
    label: 'Free',
    monthlyPriceInr: 0,
    staffSeats: 3,
    students: 25,
    reminders: {
      total: 150,
      whatsapp: 60,
      sms: 60,
      voice: 60,
      email: 150,
    },
    storageBytes: 1 * GB,
    chatMessages: 5000,
    noticePosts: 50,
    warningThreshold: 0.8,
    criticalThreshold: 1,
  },
  pro: {
    id: 'pro',
    label: 'Pro',
    monthlyPriceInr: 999,
    staffSeats: 25,
    students: 200,
    reminders: {
      total: 5000,
      whatsapp: 2500,
      sms: 1500,
      voice: 1500,
      email: 5000,
    },
    storageBytes: 20 * GB,
    chatMessages: 75000,
    noticePosts: 500,
    warningThreshold: 0.85,
    criticalThreshold: 1,
  },
  enterprise: {
    id: 'enterprise',
    label: 'Enterprise',
    monthlyPriceInr: null,
    staffSeats: 100,
    students: 5000,
    reminders: {
      total: 25000,
      whatsapp: 15000,
      sms: 8000,
      voice: 8000,
      email: 25000,
    },
    storageBytes: 100 * GB,
    chatMessages: 500000,
    noticePosts: 2000,
    warningThreshold: 0.9,
    criticalThreshold: 1.05,
  },
};

export type UsageStatus = 'ok' | 'warning' | 'critical';

export interface UsageStatusOptions {
  warningThreshold?: number;
  criticalThreshold?: number;
}

export function getPlanLimits(planId?: string | null): PlanLimits {
  if (!planId) {
    return PLAN_LIMITS.free;
  }
  if (planId in PLAN_LIMITS) {
    return PLAN_LIMITS[planId as PlanId];
  }
  return PLAN_LIMITS.free;
}

export function getUsageStatus(value: number, limit: number): UsageStatus {
  if (!Number.isFinite(limit) || limit <= 0) {
    return 'ok';
  }
  const ratio = value / limit;
  if (ratio >= 1) {
    return 'critical';
  }
  if (ratio >= 0.8) {
    return 'warning';
  }
  return 'ok';
}

export function getUsagePercentage(value: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) {
    return 0;
  }
  return Math.min(100, Number(((value / limit) * 100).toFixed(2)));
}
