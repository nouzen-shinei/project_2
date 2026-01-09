import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import type { firestore as FirestoreNS, database as DatabaseNS } from 'firebase-admin';
import type { PlanId, PlanLimits } from '../lib/planLimits';
import { resolveEffectivePlanLimitsForTenant, type TenantQuotaOverrides } from '../lib/effectivePlanLimits';
import { stripUndefinedDeep } from '../lib/stripUndefinedDeep';
import { notifyUsageAlert } from '../usageAlertNotifier';

import type { UsageMetricKey } from '../lib/usageMetrics';
const MONTH_ID_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

const METRIC_LABELS: Record<UsageMetricKey, string> = {
  students: 'Students',
  staff: 'Team seats',
  reminders: 'Monthly reminders',
  storage: 'Storage',
};

const ALERT_THROTTLE_HOURS = Math.max(1, Number(process.env.USAGE_ALERT_THROTTLE_HOURS ?? '24'));
const ALERT_THROTTLE_MS = ALERT_THROTTLE_HOURS * 60 * 60 * 1000;

const DEFAULT_STORAGE_PREFIXES: Array<{ label: string; template: string }> = [
  { label: 'tenant-branding', template: 'tenant-branding/{tenantId}' },
  { label: 'chat-files', template: 'chat-files/{tenantId}' },
  { label: 'notices', template: 'notices/{tenantId}' },
  { label: 'receipts', template: 'receipts/{tenantId}' },
  { label: 'student-profiles', template: 'student_profiles/{tenantId}' },
  { label: 'profile-pictures', template: 'profile-pictures/{tenantId}' },
];

type Firestore = FirestoreNS.Firestore;
type Timestamp = FirestoreNS.Timestamp;
type DocumentReference = FirestoreNS.DocumentReference;
type StorageBucket = ReturnType<admin.storage.Storage['bucket']>;
type RealtimeDatabase = DatabaseNS.Database;

type ReminderChannel = 'whatsapp' | 'sms' | 'email' | 'voice';

export type CliOptions = {
  tenantId?: string | null;
  month?: string | null;
  backfill: number;
  dryRun: boolean;
  verbose: boolean;
};

interface TenantRecord {
  id: string;
  name?: string;
  status?: string;
  billingTier: PlanId;
  quotas?: TenantQuotaOverrides;
}

interface MonthCursor {
  id: string;
  startDate: Date;
  endDate: Date;
  startIso: string;
  endIso: string;
  startTimestamp: Timestamp;
  endTimestamp: Timestamp;
}

interface ReminderBreakdown {
  total: number;
  whatsapp: number;
  sms: number;
  email: number;
  voice: number;
  other: number;
}

interface PaymentsReceivedBreakdown {
  count: number;
  amount: number;
}

interface AggregatedMetrics {
  studentsAdded: number;
  activeStudents: number;
  staffSeatsUsed: number;
  remindersSent: ReminderBreakdown;
  paymentsReceived: PaymentsReceivedBreakdown;
  noticePosts: number;
  deviceActions: number;
  chatMessages: number | null;
  chatAttachmentBytes: number | null;
  storageBytes: number | null;
  storageSources: Array<{ label: string; bytes: number }>;
}

interface MetricResult {
  data: AggregatedMetrics;
  warnings: string[];
}

interface StorageEstimationResult {
  totalBytes: number;
  sources: Array<{ label: string; bytes: number }>;
}

interface ChatActivityResult {
  messageCount: number;
  attachmentBytes: number;
}

type AlertThrottleState = Record<string, string>;

interface ExistingAlertRecord {
  id: string;
  metric: UsageMetricKey;
  type: 'warning' | 'critical';
  createdAt?: string | null;
  acknowledgedAt?: string | null;
}

export function initFirebase(): void {
  if (admin.apps.length > 0) {
    return;
  }

  const credentialB64 =
    process.env.FIREBASE_SERVICE_ACCOUNT_B64 ||
    process.env.FIREBASE_ADMIN_CREDENTIALS_B64 ||
    process.env.FIREBASE_SA_B64;
  const credentialPath =
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_SA_PATH;

  let credential: admin.credential.Credential | undefined;

  if (credentialB64) {
    try {
      const json = Buffer.from(credentialB64, 'base64').toString('utf8');
      credential = admin.credential.cert(JSON.parse(json));
    } catch (error) {
      console.warn('[rollup:init] failed to parse FIREBASE_SERVICE_ACCOUNT_B64', error);
    }
  }

  if (!credential && credentialPath && fs.existsSync(credentialPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
      credential = admin.credential.cert(raw);
    } catch (error) {
      console.warn('[rollup:init] failed to load credentials from path', credentialPath, error);
    }
  }

  if (!credential && process.env.NODE_ENV !== 'production') {
    const bundledCredentialB64Path = path.resolve(__dirname, '../../firebase_sa.b64');
    if (fs.existsSync(bundledCredentialB64Path)) {
      try {
        const bundledRaw = fs.readFileSync(bundledCredentialB64Path, 'utf8').trim();
        if (bundledRaw) {
          try {
            const decoded = Buffer.from(bundledRaw, 'base64').toString('utf8');
            credential = admin.credential.cert(JSON.parse(decoded));
          } catch {
            // If the file isn't base64 (or isn't padded), try JSON directly.
            credential = admin.credential.cert(JSON.parse(bundledRaw));
          }
        }
      } catch (error) {
        console.warn('[rollup:init] failed to load bundled firebase_sa.b64', error);
      }
    }
  }

  if (!credential) {
    try {
      credential = admin.credential.applicationDefault();
    } catch (error) {
      console.warn('[rollup:init] falling back to unauthenticated admin SDK init', error);
    }
  }

  admin.initializeApp({
    credential: credential ?? undefined,
    projectId: process.env.FIREBASE_PROJECT_ID,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  });
}

function normalizeMonthId(value?: string | null): string {
  if (value && MONTH_ID_REGEX.test(value.trim())) {
    return value.trim();
  }
  return formatMonthId(new Date());
}

function formatMonthId(date: Date): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  return `${year}-${month.toString().padStart(2, '0')}`;
}

function buildMonthCursor(monthId: string): MonthCursor {
  const [yearStr, monthStr] = monthId.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    throw new Error(`Invalid month id ${monthId}`);
  }
  const startDate = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0, 0));
  const endDate = new Date(Date.UTC(year, month, 1, 0, 0, 0, 0));
  return {
    id: monthId,
    startDate,
    endDate,
    startIso: startDate.toISOString(),
    endIso: endDate.toISOString(),
    startTimestamp: admin.firestore.Timestamp.fromDate(startDate),
    endTimestamp: admin.firestore.Timestamp.fromDate(endDate),
  };
}

function buildMonthCursorList(baseMonthId: string, backfill: number): MonthCursor[] {
  const list: MonthCursor[] = [];
  const baseDate = new Date(Date.UTC(Number(baseMonthId.slice(0, 4)), Number(baseMonthId.slice(5, 7)) - 1, 1));
  for (let offset = 0; offset <= backfill; offset += 1) {
    const cursorDate = new Date(baseDate.getTime());
    cursorDate.setUTCMonth(cursorDate.getUTCMonth() - offset);
    const cursorId = formatMonthId(cursorDate);
    list.push(buildMonthCursor(cursorId));
  }
  return list;
}

async function loadTenantRecords(db: Firestore, tenantId?: string | null): Promise<TenantRecord[]> {
  if (tenantId) {
    const doc = await db.collection('tenants').doc(tenantId).get();
    if (!doc.exists) {
      throw new Error(`Tenant ${tenantId} not found`);
    }
    const data = doc.data() || {};
    const quotasRaw = typeof (data as any).quotas === 'object' && (data as any).quotas ? (data as any).quotas : null;
    return [
      {
        id: doc.id,
        name: typeof data.name === 'string' ? data.name : undefined,
        status: typeof data.status === 'string' ? data.status : undefined,
        billingTier: normalizePlanId(data.billingTier),
        quotas: quotasRaw
          ? {
              maxStudents: typeof quotasRaw.maxStudents === 'number' ? quotasRaw.maxStudents : null,
              maxStaff: typeof quotasRaw.maxStaff === 'number' ? quotasRaw.maxStaff : null,
              maxMonthlyReminders: typeof quotasRaw.maxMonthlyReminders === 'number' ? quotasRaw.maxMonthlyReminders : null,
              maxMonthlyVoiceReminders:
                typeof quotasRaw.maxMonthlyVoiceReminders === 'number' ? quotasRaw.maxMonthlyVoiceReminders : null,
              maxStorageMb: typeof quotasRaw.maxStorageMb === 'number' ? quotasRaw.maxStorageMb : null,
            }
          : undefined,
      },
    ];
  }

  const snapshot = await db.collection('tenants').where('status', '==', 'active').get();
  if (snapshot.empty) {
    return [];
  }
  return snapshot.docs.map((doc) => {
    const data = doc.data() || {};
    const quotasRaw = typeof (data as any).quotas === 'object' && (data as any).quotas ? (data as any).quotas : null;
    return {
      id: doc.id,
      name: typeof data.name === 'string' ? data.name : undefined,
      status: typeof data.status === 'string' ? data.status : undefined,
      billingTier: normalizePlanId(data.billingTier),
      quotas: quotasRaw
        ? {
            maxStudents: typeof quotasRaw.maxStudents === 'number' ? quotasRaw.maxStudents : null,
            maxStaff: typeof quotasRaw.maxStaff === 'number' ? quotasRaw.maxStaff : null,
            maxMonthlyReminders: typeof quotasRaw.maxMonthlyReminders === 'number' ? quotasRaw.maxMonthlyReminders : null,
            maxMonthlyVoiceReminders:
              typeof quotasRaw.maxMonthlyVoiceReminders === 'number' ? quotasRaw.maxMonthlyVoiceReminders : null,
            maxStorageMb: typeof quotasRaw.maxStorageMb === 'number' ? quotasRaw.maxStorageMb : null,
          }
        : undefined,
    } satisfies TenantRecord;
  });
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

async function countQuery(query: FirestoreNS.Query, label: string, verbose = false): Promise<number> {
  try {
    const anyQuery = query as FirestoreNS.Query & { count?: () => { get: () => Promise<{ data(): { count: number } }> } };
    if (typeof anyQuery.count === 'function') {
      const snapshot = await anyQuery.count().get();
      return snapshot.data().count ?? 0;
    }
    const snapshot = await query.get();
    return snapshot.size;
  } catch (error) {
    if (verbose) {
      console.warn(`[rollup] count query failed (${label})`, error);
    }
    throw error;
  }
}

async function countStudentsAdded(db: Firestore, tenantId: string, month: MonthCursor): Promise<number> {
  const query = db
    .collection('students')
    .where('tenantId', '==', tenantId)
    .where('createdAt', '>=', month.startIso)
    .where('createdAt', '<', month.endIso);
  return countQuery(query, `studentsAdded:${tenantId}:${month.id}`);
}

async function countActiveStudents(db: Firestore, tenantId: string): Promise<number> {
  const query = db
    .collection('students')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'active');
  return countQuery(query, `activeStudents:${tenantId}`);
}

async function countActiveStaffSeats(db: Firestore, tenantId: string): Promise<number> {
  const snapshot = await db
    .collection('tenantMemberships')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'active')
    .get();
  if (snapshot.empty) {
    return 0;
  }
  let count = 0;
  snapshot.forEach((doc) => {
    const role = (doc.data()?.role || '').toString().toLowerCase();
    if (role === 'owner' || role === 'admin' || role === 'staff') {
      count += 1;
    }
  });
  return count;
}

async function countPendingSeatInvites(db: Firestore, tenantId: string): Promise<number> {
  const snapshot = await db
    .collection('tenantInvites')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'pending')
    .get();
  if (snapshot.empty) {
    return 0;
  }
  let count = 0;
  snapshot.forEach((doc) => {
    const role = (doc.data()?.role || '').toString().toLowerCase();
    if (role === 'owner' || role === 'admin' || role === 'staff') {
      count += 1;
    }
  });
  return count;
}

async function collectReminderBreakdown(db: Firestore, tenantId: string, month: MonthCursor): Promise<ReminderBreakdown> {
  const baseQuery = db
    .collection('reminderHistory')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'success')
    .where('createdAt', '>=', month.startTimestamp)
    .where('createdAt', '<', month.endTimestamp);

  const total = await countQuery(baseQuery, `reminders:total:${tenantId}:${month.id}`);
  const channelCounts: Record<ReminderChannel, number> = {
    whatsapp: 0,
    sms: 0,
    email: 0,
    voice: 0,
  };

  await Promise.all(
    (Object.keys(channelCounts) as ReminderChannel[]).map(async (channel) => {
      const channelQuery = baseQuery.where('reminderType', '==', channel);
      channelCounts[channel] = await countQuery(channelQuery, `reminders:${channel}:${tenantId}:${month.id}`);
    })
  );

  const categorized = channelCounts.whatsapp + channelCounts.sms + channelCounts.email + channelCounts.voice;
  const other = Math.max(0, total - categorized);

  return {
    total,
    whatsapp: channelCounts.whatsapp,
    sms: channelCounts.sms,
    email: channelCounts.email,
    voice: channelCounts.voice,
    other,
  };
}

async function countNoticePosts(db: Firestore, tenantId: string, month: MonthCursor): Promise<number> {
  const query = db
    .collection('notices')
    .where('tenantId', '==', tenantId)
    .where('createdAt', '>=', month.startTimestamp)
    .where('createdAt', '<', month.endTimestamp);
  return countQuery(query, `notices:${tenantId}:${month.id}`);
}

async function countDeviceActions(db: Firestore, tenantId: string, month: MonthCursor): Promise<number> {
  const query = db
    .collection('device_actions')
    .where('tenantId', '==', tenantId)
    .where('timestamp', '>=', month.startTimestamp)
    .where('timestamp', '<', month.endTimestamp);
  return countQuery(query, `device_actions:${tenantId}:${month.id}`);
}

async function estimateStorageBytes(
  db: Firestore,
  bucket: StorageBucket | null,
  tenantId: string
): Promise<StorageEstimationResult> {
  const sources: Array<{ label: string; bytes: number }> = [];

  const prefixConfigs = resolveStoragePrefixConfigs();
  if (bucket && prefixConfigs.length > 0) {
    for (const config of prefixConfigs) {
      const prefix = config.template.replace('{tenantId}', tenantId);
      if (!prefix) {
        continue;
      }
      const bytes = await sumStoragePrefixBytes(bucket, prefix);
      if (bytes > 0) {
        sources.push({ label: config.label, bytes });
      }
    }
  }

  const noticeAudioBytes = await sumNoticeAudioBytes(db, tenantId);
  if (noticeAudioBytes > 0) {
    sources.push({ label: 'notice-audio-files', bytes: noticeAudioBytes });
  }

  const externalCollection = (process.env.USAGE_STORAGE_STATS_COLLECTION || '').trim();
  if (externalCollection) {
    try {
      const externalSnap = await db.collection(externalCollection).doc(tenantId).get();
      if (externalSnap.exists) {
        const data = externalSnap.data() || {};
        const bytes = Number(data.totalBytes ?? data.bytes ?? 0);
        if (Number.isFinite(bytes) && bytes > 0) {
          const label = typeof data.label === 'string' && data.label.trim() ? data.label.trim() : 'external-storage';
          sources.push({ label, bytes });
        }
      }
    } catch (error) {
      console.warn('[rollup] failed to load external storage stats', {
        tenantId,
        collection: externalCollection,
        error,
      });
    }
  }

  const totalBytes = sources.reduce((sum, entry) => sum + entry.bytes, 0);
  return { totalBytes, sources };
}

async function sumStoragePrefixBytes(bucket: StorageBucket, prefix: string): Promise<number> {
  try {
    let total = 0;
    let nextPageToken: string | undefined;
    do {
      const [files, , response] = await bucket.getFiles({ prefix, pageToken: nextPageToken });
      files.forEach((file) => {
        const sizeRaw = (file.metadata as any)?.size;
        const size = typeof sizeRaw === 'string' ? Number(sizeRaw) : typeof sizeRaw === 'number' ? sizeRaw : 0;
        if (Number.isFinite(size) && size > 0) {
          total += size;
        }
      });
      nextPageToken = (response as any)?.nextPageToken;
    } while (nextPageToken);
    return total;
  } catch (error) {
    console.warn(`[rollup] storage listing failed for prefix ${prefix}`, error);
    return 0;
  }
}

async function sumNoticeAudioBytes(db: Firestore, tenantId: string): Promise<number> {
  const snapshot = await db.collection('notices').where('tenantId', '==', tenantId).get();
  if (snapshot.empty) {
    return 0;
  }
  let total = 0;
  snapshot.forEach((doc) => {
    const data = doc.data() || {};
    const size = Number(data.audioFileSize ?? data.audioSize ?? 0);
    if (Number.isFinite(size) && size > 0) {
      total += size;
    }
  });
  return total;
}

function resolveStoragePrefixConfigs(): Array<{ label: string; template: string }> {
  const configs: Array<{ label: string; template: string }> = [...DEFAULT_STORAGE_PREFIXES];
  const extraRaw = process.env.USAGE_STORAGE_EXTRA_PREFIXES;
  if (!extraRaw) {
    return configs;
  }
  extraRaw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const [labelPart, templatePart] = entry.split('=').map((segment) => segment.trim());
      if (!templatePart) {
        return;
      }
      const label = labelPart || templatePart.replace('{tenantId}', '').replace(/\//g, '-').replace(/^-+|-+$/g, '') || 'storage';
      configs.push({ label, template: templatePart });
    });
  return configs;
}

function normalizeTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function collectChatActivity(
  realtimeDb: RealtimeDatabase | null,
  tenantId: string,
  month: MonthCursor
): Promise<ChatActivityResult> {
  if (!realtimeDb) {
    throw new Error('Realtime Database is not configured; set FIREBASE_DATABASE_URL.');
  }

  const tenantRoot = realtimeDb.ref('tenantChat').child(tenantId);
  const query = tenantRoot.child('messageIndex').orderByChild('timestamp').startAt(month.startIso).endAt(month.endIso);
  const snapshot = await query.get();
  if (!snapshot.exists()) {
    return { messageCount: 0, attachmentBytes: 0 };
  }

  const startMs = month.startDate.getTime();
  const endMs = month.endDate.getTime();
  let messages = 0;
  let attachmentBytes = 0;
  const attachmentFetches: Array<Promise<number>> = [];

  snapshot.forEach((child) => {
    if (!child.key) {
      return false;
    }
    const record = child.val() as {
      timestamp?: string | number | null;
      hasAttachments?: boolean;
      attachmentBytes?: number;
      conversationKey?: string;
    } | null;
    const timestampMs = normalizeTimestampMs(record?.timestamp ?? null);
    if (timestampMs == null || timestampMs < startMs || timestampMs >= endMs) {
      return false;
    }
    messages += 1;
    const trackedBytes = Number(record?.attachmentBytes ?? 0);
    if (Number.isFinite(trackedBytes) && trackedBytes > 0) {
      attachmentBytes += trackedBytes;
    } else if (record?.hasAttachments && typeof record.conversationKey === 'string') {
      attachmentFetches.push(
        fetchAttachmentBytesFromMessage(realtimeDb, tenantId, record.conversationKey, child.key).catch(() => 0)
      );
    }
    return false;
  });

  if (attachmentFetches.length > 0) {
    const fallback = await Promise.all(attachmentFetches);
    attachmentBytes += fallback.reduce((sum, value) => sum + value, 0);
  }

  return { messageCount: messages, attachmentBytes };
}

async function fetchAttachmentBytesFromMessage(
  realtimeDb: RealtimeDatabase,
  tenantId: string,
  conversationKey: string,
  messageId: string
): Promise<number> {
  try {
    const snapshot = await realtimeDb
      .ref('tenantChat')
      .child(tenantId)
      .child('conversationMessages')
      .child(conversationKey)
      .child(messageId)
      .get();
    if (!snapshot.exists()) {
      return 0;
    }
    const raw = (snapshot.val() as Record<string, unknown>) || null;
    return sumAttachmentBytesFromPayload(raw);
  } catch (error) {
    console.warn('[rollup] failed to resolve chat attachment bytes', {
      conversationKey,
      messageId,
      error,
    });
    return 0;
  }
}

function sumAttachmentBytesFromPayload(raw: Record<string, unknown> | null): number {
  if (!raw) {
    return 0;
  }
  let total = 0;
  const fileSize = Number((raw as { fileSize?: unknown }).fileSize ?? 0);
  if (Number.isFinite(fileSize) && fileSize > 0) {
    total += fileSize;
  }
  const attachments = (raw as { attachments?: Array<Record<string, unknown>> }).attachments;
  if (Array.isArray(attachments)) {
    for (const entry of attachments) {
      const size = Number(entry?.fileSize ?? 0);
      if (Number.isFinite(size) && size > 0) {
        total += size;
      }
    }
  }
  return total;
}

async function collectPaymentsReceived(
  db: Firestore,
  tenantId: string,
  month: MonthCursor
): Promise<PaymentsReceivedBreakdown> {
  const PAGE_SIZE = 1000;
  let lastDoc: FirestoreNS.QueryDocumentSnapshot | null = null;
  let totalCount = 0;
  let totalAmount = 0;

  while (true) {
    let paymentsQuery = db
      .collectionGroup('payments')
      .where('tenantId', '==', tenantId)
      .where('paymentDate', '>=', month.startIso)
      .where('paymentDate', '<=', month.endIso)
      .orderBy('paymentDate')
      .limit(PAGE_SIZE);

    if (lastDoc) {
      paymentsQuery = paymentsQuery.startAfter(lastDoc);
    }

    const snap = await paymentsQuery.get();
    if (snap.empty) {
      break;
    }

    for (const doc of snap.docs) {
      totalCount += 1;
      const data = doc.data() as any;
      const amountRaw = data?.amount;
      const amount = typeof amountRaw === 'number' && Number.isFinite(amountRaw) ? amountRaw : Number(amountRaw);
      if (Number.isFinite(amount)) {
        totalAmount += amount;
      }
    }

    lastDoc = snap.docs[snap.docs.length - 1] ?? null;
    if (snap.size < PAGE_SIZE) {
      break;
    }
  }

  return { count: totalCount, amount: totalAmount };
}

async function collectMetrics(
  db: Firestore,
  realtimeDb: RealtimeDatabase | null,
  bucket: StorageBucket | null,
  tenant: TenantRecord,
  month: MonthCursor,
  existingData: FirestoreNS.DocumentData | undefined,
  verbose: boolean
): Promise<MetricResult> {
  const warnings: string[] = [];

  const [studentsAdded, studentsWarning] = await withFallback(
    () => countStudentsAdded(db, tenant.id, month),
    getNumber(existingData?.studentsAdded)
  );
  if (studentsWarning) warnings.push(`[studentsAdded] ${studentsWarning}`);

  const [activeStudents, activeStudentsWarning] = await withFallback(
    () => countActiveStudents(db, tenant.id),
    getNumber(existingData?.activeStudents)
  );
  if (activeStudentsWarning) warnings.push(`[activeStudents] ${activeStudentsWarning}`);

  const [staffSeatsUsed, staffWarning] = await withFallback(
    async () => {
      const [activeSeats, pendingInvites] = await Promise.all([
        countActiveStaffSeats(db, tenant.id),
        countPendingSeatInvites(db, tenant.id),
      ]);
      return activeSeats + pendingInvites;
    },
    getNumber(existingData?.staffSeatsUsed)
  );
  if (staffWarning) warnings.push(`[staffSeats] ${staffWarning}`);

  const fallbackReminders = normalizeReminderFallback(existingData?.remindersSent);
  const [remindersSent, remindersWarning] = await withFallback(
    () => collectReminderBreakdown(db, tenant.id, month),
    fallbackReminders
  );
  if (remindersWarning) warnings.push(`[reminders] ${remindersWarning}`);

  const fallbackPaymentsReceived: PaymentsReceivedBreakdown = {
    count: getNumber((existingData as any)?.paymentsReceived?.count ?? (existingData as any)?.paymentsReceivedCount ?? 0),
    amount: getNumber((existingData as any)?.paymentsReceived?.amount ?? (existingData as any)?.paymentsReceivedAmount ?? 0),
  };
  const [paymentsReceived, paymentsWarning] = await withFallback(
    () => collectPaymentsReceived(db, tenant.id, month),
    fallbackPaymentsReceived
  );
  if (paymentsWarning) warnings.push(`[paymentsReceived] ${paymentsWarning}`);

  const [noticePosts, noticesWarning] = await withFallback(
    () => countNoticePosts(db, tenant.id, month),
    getNumber(existingData?.noticePosts)
  );
  if (noticesWarning) warnings.push(`[notices] ${noticesWarning}`);

  const [deviceActions, deviceWarning] = await withFallback(
    () => countDeviceActions(db, tenant.id, month),
    getNumber(existingData?.deviceActions)
  );
  if (deviceWarning) warnings.push(`[deviceActions] ${deviceWarning}`);

  const fallbackChatMetrics: ChatActivityResult = {
    messageCount: getNumber(existingData?.chatMessages),
    attachmentBytes: getNumber(existingData?.chatAttachmentBytes),
  };
  const [chatActivity, chatWarning] = await withFallback(
    () => collectChatActivity(realtimeDb, tenant.id, month),
    fallbackChatMetrics
  );
  if (chatWarning) warnings.push(`[chatMessages] ${chatWarning}`);

  const [storageEstimate, storageWarning] = await withFallback(
    () => estimateStorageBytes(db, bucket, tenant.id),
    {
      totalBytes: typeof existingData?.storageBytes === 'number' ? existingData.storageBytes : 0,
      sources: Array.isArray(existingData?.storageSources) ? existingData.storageSources : [],
    }
  );
  if (storageWarning) warnings.push(`[storage] ${storageWarning}`);

  let storageBytes = storageEstimate.totalBytes;
  const storageSources = [...storageEstimate.sources];
  if (chatActivity.attachmentBytes > 0) {
    storageBytes += chatActivity.attachmentBytes;
    storageSources.push({ label: 'chat-attachments', bytes: chatActivity.attachmentBytes });
  }

  const data: AggregatedMetrics = {
    studentsAdded,
    activeStudents,
    staffSeatsUsed,
    remindersSent,
    paymentsReceived,
    noticePosts,
    deviceActions,
    chatMessages: chatActivity.messageCount,
    chatAttachmentBytes: chatActivity.attachmentBytes,
    storageBytes,
    storageSources,
  };
  return { data, warnings };
}

function getNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeReminderFallback(value: unknown): ReminderBreakdown {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return {
      total: getNumber(record.total),
      whatsapp: getNumber(record.whatsapp),
      sms: getNumber(record.sms),
      email: getNumber(record.email),
      voice: getNumber(record.voice),
      other: getNumber(record.other),
    } satisfies ReminderBreakdown;
  }
  return { total: 0, whatsapp: 0, sms: 0, email: 0, voice: 0, other: 0 };
}

async function withFallback<T>(
  fn: () => Promise<T>,
  fallback: T
): Promise<[T, string | null]> {
  try {
    const value = await fn();
    return [value, null];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [fallback, message];
  }
}

async function loadExistingAlerts(usageDocRef: DocumentReference): Promise<ExistingAlertRecord[]> {
  try {
    const snapshot = await usageDocRef.collection('alerts').orderBy('createdAt', 'desc').limit(50).get();
    if (snapshot.empty) {
      return [];
    }
    return snapshot.docs.map((doc) => {
      const data = doc.data() || {};
      const metric = (typeof data.metric === 'string' ? data.metric : 'reminders') as UsageMetricKey;
      const type = data.type === 'critical' ? 'critical' : 'warning';
      const createdAt = typeof (data as any).createdAt === 'string' ? (data as any).createdAt : null;
      const acknowledgedAt = typeof (data as any).acknowledgedAt === 'string' ? (data as any).acknowledgedAt : null;
      return { id: doc.id, metric, type, createdAt, acknowledgedAt } satisfies ExistingAlertRecord;
    });
  } catch (error) {
    console.warn('[rollup] failed to load alerts', error);
    return [];
  }
}

function normalizeAlertThrottleState(raw: unknown): AlertThrottleState {
  if (!raw || typeof raw !== 'object') {
    return {};
  }
  const result: AlertThrottleState = {};
  Object.entries(raw as Record<string, unknown>).forEach(([key, value]) => {
    if (typeof key === 'string' && typeof value === 'string' && key && value) {
      result[key] = value;
    }
  });
  return result;
}

function getAlertThrottleKey(metric: UsageMetricKey, threshold: 'warning' | 'critical'): string {
  return `${metric}_${threshold}`;
}

function hasActiveAlertThrottle(state: AlertThrottleState, key: string): boolean {
  const timestamp = state[key];
  if (!timestamp) {
    return false;
  }
  const issuedAt = Date.parse(timestamp);
  if (!Number.isFinite(issuedAt)) {
    return false;
  }
  return Date.now() - issuedAt < ALERT_THROTTLE_MS;
}

async function recordAlertThrottleTimestamp(
  usageDocRef: DocumentReference,
  key: string,
  isoTimestamp: string
): Promise<void> {
  await usageDocRef.set({ [`alertThrottles.${key}`]: isoTimestamp }, { merge: true });
}

function formatMetricValue(metric: UsageMetricKey, value: number): string {
  if (metric === 'storage') {
    const gb = value / (1024 * 1024 * 1024);
    if (gb >= 1) {
      return `${gb.toFixed(1)} GB`;
    }
    const mb = value / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }
  return value.toLocaleString('en-IN');
}

async function createUsageNoticeForAlert(
  usageDocRef: DocumentReference,
  tenantId: string | null,
  monthId: string,
  metric: UsageMetricKey,
  ratio: number,
  value: number,
  limit: number,
  threshold: 'warning' | 'critical',
  dryRun: boolean
): Promise<void> {
  if (!tenantId) {
    return;
  }

  const priority = threshold === 'critical' ? 'high' : 'medium';
  const metricLabel = METRIC_LABELS[metric] ?? metric;
  const percentage = Math.round(ratio * 100);
  const valueLabel = formatMetricValue(metric, value);
  const limitLabel = formatMetricValue(metric, limit);

  const title = threshold === 'critical'
    ? `Usage limit hit: ${metricLabel}`
    : `Usage warning: ${metricLabel} at ${percentage}%`;
  const content = threshold === 'critical'
    ? `${metricLabel} usage reached ${valueLabel} (${percentage}% of ${limitLabel}) for ${monthId}. Clear space or upgrade to restore full access.`
    : `${metricLabel} usage is at ${percentage}% (${valueLabel} of ${limitLabel}) for ${monthId}. Review usage before limits are enforced.`;

  if (dryRun) {
    console.log(`[rollup][dry-run] would create notice for ${tenantId}: ${title}`);
    return;
  }

  const firestore = usageDocRef.firestore;
  const noticesRef = firestore.collection('notices');
  await noticesRef.add(stripUndefinedDeep({
    tenantId,
    title,
    content,
    priority,
    targetAudience: ['admins'],
    isActive: true,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: 'usage_rollup',
    createdByName: 'Usage Monitor',
    createdByEmail: 'usage-monitor@system',
    viewCount: 0,
    userViews: {},
    metadata: {
      metric,
      ratio,
      value,
      limit,
      monthId,
      threshold,
    },
  } as Record<string, unknown>));
}

async function evaluateAlerts(
  usageDocRef: DocumentReference,
  planLimits: PlanLimits,
  metrics: AggregatedMetrics,
  dryRun: boolean,
  tenantId: string,
  monthId: string,
  tenantName?: string | undefined,
  alertThrottleState?: AlertThrottleState | undefined
): Promise<void> {
  const candidates: Array<{ metric: UsageMetricKey; value: number; limit: number }> = [
    { metric: 'students', value: metrics.activeStudents, limit: planLimits.students },
    { metric: 'staff', value: metrics.staffSeatsUsed, limit: planLimits.staffSeats },
    { metric: 'reminders', value: metrics.remindersSent.total, limit: planLimits.reminders.total },
    { metric: 'storage', value: metrics.storageBytes ?? 0, limit: planLimits.storageBytes },
  ];

  const existingAlerts = await loadExistingAlerts(usageDocRef);
  const existingByKey = new Map<string, { id: string; acknowledgedAt?: string | null; createdAt?: string | null }>();
  for (const alert of existingAlerts) {
    const key = `${String(alert.metric)}:${String(alert.type)}`;
    if (!existingByKey.has(key)) {
      existingByKey.set(key, { id: alert.id, acknowledgedAt: (alert as any).acknowledgedAt ?? null, createdAt: alert.createdAt ?? null });
    }
  }
  const throttleState = normalizeAlertThrottleState(alertThrottleState);

  await Promise.all(
    candidates.map(async (entry) => {
      if (entry.limit <= 0) {
        return;
      }
      const ratio = entry.value / entry.limit;
      let threshold: 'warning' | 'critical' | null = null;
      if (ratio >= planLimits.criticalThreshold) {
        threshold = 'critical';
      } else if (ratio >= planLimits.warningThreshold) {
        threshold = 'warning';
      }
      if (!threshold) {
        return;
      }

      // Ensure one open alert per metric + threshold (idempotent upsert).
      const alertKey = `${String(entry.metric)}:${String(threshold)}`;
      const docId = `${String(entry.metric)}_${String(threshold)}`;
      const existing = existingByKey.get(alertKey) ?? null;

      // If there's already an open alert, refresh its values so the UI stays current.
      if (existing && !existing.acknowledgedAt) {
        if (!dryRun) {
          await usageDocRef
            .collection('alerts')
            .doc(docId)
            .set(
              stripUndefinedDeep({
                metric: entry.metric,
                type: threshold,
                value: entry.value,
                limit: entry.limit,
                ratio,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAtIso: new Date().toISOString(),
              }),
              { merge: true }
            );
        }
        return;
      }

      const throttleKey = getAlertThrottleKey(entry.metric, threshold);
      if (hasActiveAlertThrottle(throttleState, throttleKey)) {
        if (dryRun) {
          console.warn(
            `[rollup][dry-run] would skip ${threshold} alert for ${entry.metric} due to throttle ${ALERT_THROTTLE_HOURS}h`
          );
        } else if (process.env.USAGE_ALERT_DEBUG === '1') {
          console.log('[rollup] throttling usage alert', {
            tenantId,
            monthId,
            metric: entry.metric,
            threshold,
            throttleKey,
          });
        }
        return;
      }
      if (dryRun) {
        console.warn(
          `[rollup][dry-run] would create ${threshold} alert for ${entry.metric}: value=${entry.value} limit=${entry.limit}`
        );
        return;
      }

      const createdAtIso = new Date().toISOString();
      const alertDoc = usageDocRef.collection('alerts').doc(docId);
      await alertDoc.set(
        stripUndefinedDeep({
          metric: entry.metric,
          type: threshold,
          value: entry.value,
          limit: entry.limit,
          ratio,
          createdAt: createdAtIso,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAtIso: createdAtIso,
        }),
        { merge: true }
      );
      console.log(
        `[rollup] alert created ${usageDocRef.path} metric=${entry.metric} type=${threshold} ratio=${(ratio * 100).toFixed(2)}%`
      );
      const throttleTimestamp = new Date().toISOString();
      await recordAlertThrottleTimestamp(usageDocRef, throttleKey, throttleTimestamp);
      await createUsageNoticeForAlert(
        usageDocRef,
        tenantId,
        monthId,
        entry.metric,
        ratio,
        entry.value,
        entry.limit,
        threshold,
        dryRun
      );
      if (!dryRun) {
        try {
          const notificationSummary = await notifyUsageAlert({
            tenantId,
            tenantName,
            monthId,
            metric: entry.metric,
            metricLabel: METRIC_LABELS[entry.metric] ?? entry.metric,
            threshold,
            ratio,
            value: entry.value,
            limit: entry.limit,
            alertId: alertDoc.id,
          });
          if (notificationSummary) {
            await alertDoc.set(
              stripUndefinedDeep({
                notifications: notificationSummary,
                lastNotifiedAt: admin.firestore.FieldValue.serverTimestamp(),
              }),
              { merge: true }
            );
          }
        } catch (notifyError) {
          console.error('[rollup] usage alert notification failed', {
            tenantId,
            monthId,
            metric: entry.metric,
            error: notifyError,
          });
        }
      }
    })
  );
}

async function persistUsageSnapshot(
  usageDocRef: DocumentReference,
  tenant: TenantRecord,
  month: MonthCursor,
  planId: PlanId,
  metrics: AggregatedMetrics,
  warnings: string[],
  dryRun: boolean
): Promise<void> {
  const payload: Record<string, unknown> = {
    tenantId: tenant.id,
    month: month.id,
    planId,
    studentsAdded: metrics.studentsAdded,
    activeStudents: metrics.activeStudents,
    staffSeatsUsed: metrics.staffSeatsUsed,
    remindersSent: metrics.remindersSent,
    paymentsReceived: metrics.paymentsReceived,
    noticePosts: metrics.noticePosts,
    deviceActions: metrics.deviceActions,
    chatMessages: metrics.chatMessages,
    chatAttachmentBytes: metrics.chatAttachmentBytes,
    storageBytes: metrics.storageBytes,
    storageSources: metrics.storageSources,
    metricsVersion: 1,
    lastRefreshedAt: admin.firestore.FieldValue.serverTimestamp(),
    lastRefreshedBy: process.env.ROLLUP_RUNNER_ID || process.env.GITHUB_SHA || process.env.USER || 'rollup-script',
  };

  if (warnings.length > 0) {
    payload.rollupDiagnostics = {
      warnings,
      generatedAt: new Date().toISOString(),
    };
  }

  if (dryRun) {
    console.log(`[rollup][dry-run] skipping write for ${usageDocRef.path}`);
    return;
  }

  await usageDocRef.set(stripUndefinedDeep(payload), { merge: true });
}

export async function runTenantUsageRollup(options: CliOptions): Promise<void> {
  initFirebase();
  const db = admin.firestore();
  let realtimeDb: RealtimeDatabase | null = null;
  try {
    realtimeDb = admin.database();
  } catch (error) {
    console.warn('[rollup] realtime database unavailable - chat metrics will fall back', error);
  }
  const bucket = typeof admin.app().options.storageBucket === 'string' ? admin.storage().bucket() : null;

  const monthId = normalizeMonthId(options.month);
  const months = buildMonthCursorList(monthId, options.backfill);

  const tenants = await loadTenantRecords(db, options.tenantId);
  if (!tenants.length) {
    console.warn('[rollup] No tenants matched filter');
    return;
  }

  console.log(
    `[rollup] processing ${tenants.length} tenant(s) across ${months.length} month(s)${options.dryRun ? ' (dry-run)' : ''}`
  );

  for (const month of months) {
    for (const tenant of tenants) {
      const usageDocRef = db.collection('tenantUsage').doc(tenant.id).collection('months').doc(month.id);
      const existingSnap = await usageDocRef.get();
      const existingData = existingSnap.exists ? existingSnap.data() : undefined;

      const planLimits = await resolveEffectivePlanLimitsForTenant(db, tenant.id, {
        billingTier: tenant.billingTier,
        quotas: tenant.quotas ?? null,
      });
      const { data, warnings } = await collectMetrics(db, realtimeDb, bucket, tenant, month, existingData, options.verbose);

      await persistUsageSnapshot(usageDocRef, tenant, month, planLimits.id, data, warnings, options.dryRun);
      await evaluateAlerts(
        usageDocRef,
        planLimits,
        data,
        options.dryRun,
        tenant.id,
        month.id,
        tenant.name,
        (existingData?.alertThrottles as AlertThrottleState | undefined) ?? undefined
      );

      console.log(
        `[rollup] tenant=${tenant.id} month=${month.id} students=${data.activeStudents} staff=${data.staffSeatsUsed} reminders=${data.remindersSent.total} storageMb=${((data.storageBytes ?? 0) / (1024 * 1024)).toFixed(2)}`
      );
      warnings.forEach((warning) => console.warn(`[rollup][${tenant.id}][${month.id}] ${warning}`));
    }
  }
}

export async function shutdownFirebase(): Promise<void> {
  if (!admin.apps || admin.apps.length === 0) {
    return;
  }
  await Promise.all(
    admin.apps.map(async (app) => {
      if (!app) {
        return;
      }
      try {
        await app.delete();
      } catch (error) {
        console.warn('[rollup] failed to shutdown firebase app', error);
      }
    })
  );
}
