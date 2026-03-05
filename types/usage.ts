import type { PlanId, PlanLimits, UsageStatus } from '@/lib/planLimits';

export type UsageMetricKey = 'students' | 'staff' | 'reminders' | 'storage';

export interface UsageMetricStatus {
  value: number;
  limit: number;
  percentage: number;
  status: UsageStatus;
}

export type UsageMetricStatusMap = Partial<Record<UsageMetricKey, UsageMetricStatus>>;

export interface UsageStorageSource {
  label: string;
  bytes: number;
}

export interface UsageDiagnostics {
  warnings: string[];
  generatedAt?: string;
}

export interface UsageAlertRecord {
  id: string;
  metric: UsageMetricKey;
  type: 'warning' | 'critical' | 'info';
  value?: number;
  limit?: number;
  ratio?: number;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  acknowledgedByEmail?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface UsageSummaryResponse {
  tenantId?: string;
  month: string;
  planId: PlanId;
  planLimits: PlanLimits;
  students: number;
  studentsAdded: number;
  staff: number;
  staffBreakdown?: {
    active: number;
    pendingInvites: number;
  };
  reminders: {
    total: number;
    whatsapp: number;
    sms: number;
    email: number;
    voice?: number;
    other?: number;
    inFlight?: {
      total: number;
      whatsapp: number;
      sms: number;
      email: number;
      voice: number;
    };
    reserved?: {
      total: number;
      whatsapp: number;
      sms: number;
      email: number;
      voice: number;
    };
    effectiveUsed?: number;
    effectiveRemaining?: number | null;
  };
  paymentsReceived?: {
    count: number;
    amount: number;
  };
  noticePosts: number;
  deviceActions: number;
  chatMessages: number | null;
  storageBytes: number;
  storageSources: UsageStorageSource[];
  alerts?: UsageAlertRecord[];
  metricsVersion?: number;
  lastRefreshedAt?: string;
  diagnostics?: UsageDiagnostics;
  statuses: UsageMetricStatusMap;
}

export interface UsageHistoryPoint {
  month: string;
  students: number;
  studentsAdded?: number;
  staff: number;
  remindersTotal: number;
  remindersWhatsApp?: number;
  remindersSms?: number;
  remindersEmail?: number;
  storageBytes: number;
  noticePosts?: number;
  deviceActions?: number;
  chatMessages?: number | null;
  paymentsReceivedCount?: number;
  paymentsReceivedAmount?: number;
}
