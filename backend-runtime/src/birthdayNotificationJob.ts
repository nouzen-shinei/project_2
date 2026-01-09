import * as admin from 'firebase-admin';
import { ensureFirebase, getFirestore } from './firebaseAdmin';
import { enqueueBirthdayGreeting } from './queueProvider';
import { sendExpoMessages, markPushTokensInvalid, ExpoPushMessage, PushTokenRecord } from './pushUtils';
import { matchesTenantDevice } from './tenantDeviceFilter';
import { getTenantMetadata } from './tenantMetadataCache';

const MS_PER_MINUTE = 60_000;
const IST_OFFSET_MINUTES = 330;
const DEFAULT_TEAM_NAME =
  process.env.BIRTHDAY_NOTIFICATION_SENDER_NAME ||
  process.env.COACHING_NAME ||
  process.env.EXPO_PUBLIC_COACHING_NAME ||
  'Tuition Manager Team';

const DEFAULT_WHATSAPP_COUNTRY_CODE = (() => {
  const envCode = process.env.WHATSAPP_DEFAULT_COUNTRY_CODE?.replace(/\D/g, '') || '';
  return envCode || '91';
})();

const LEGACY_COACHING_NAME_CACHE_MS = Number(process.env.BIRTHDAY_COACHING_NAME_CACHE_MS || 5 * 60 * 1000);
const BIRTHDAY_WHATSAPP_IMAGE_URL = process.env.BIRTHDAY_WHATSAPP_IMAGE_URL?.trim() || undefined;
const BIRTHDAY_PROFILE_COLLECTION = process.env.BIRTHDAY_PROFILE_COLLECTION?.trim() || 'tenantProfiles';
const BIRTHDAY_FALLBACK_COLLECTION = process.env.BIRTHDAY_FALLBACK_COLLECTION?.trim() || 'authorizedEmails';
const BIRTHDAY_PROFILE_FALLBACK_ENABLED = process.env.BIRTHDAY_PROFILE_FALLBACK !== 'false';
const BIRTHDAY_DEFAULT_TENANT_ID = process.env.BIRTHDAY_DEFAULT_TENANT_ID?.trim() || 'legacy-coaching';

let cachedLegacyCoachingName: { value: string | null; expiresAt: number } | null = null;

let schedulerStarted = false;
let scheduledTimer: NodeJS.Timeout | undefined;

export interface BirthdayJobStats {
  totalDocuments: number;
  matchedToday: number;
  notifiedCount: number;
  tokensSent: number;
  alreadySent: number;
  missingDateOfBirth: number;
  noTokens: number;
  skippedOptOut: number;
  whatsappEnqueued: number;
  whatsappFailed: number;
  forcedRecipients: number;
}

export interface BirthdayJobOptions {
  now?: Date;
  targetEmails?: string[];
  targetDeviceIds?: string[];
  dryRun?: boolean;
  skipWhatsApp?: boolean;
  forceSend?: boolean;
  suppressStateUpdates?: boolean;
  reason?: string;
  tenantId?: string;
}

export function startBirthdayNotificationScheduler(): void {
  if (process.env.BIRTHDAY_NOTIFICATIONS_ENABLED === 'false') {
    console.log('[birthday_job] scheduler disabled via env');
    return;
  }

  if (schedulerStarted) return;
  schedulerStarted = true;

  const runOnStart = (process.env.BIRTHDAY_NOTIFICATIONS_RUN_ON_START ?? 'false').toLowerCase() === 'true';
  if (runOnStart) {
    const startDelayRaw = Number(process.env.BIRTHDAY_NOTIFICATIONS_START_DELAY_MS || 15000);
    const startDelay = Number.isFinite(startDelayRaw) && startDelayRaw >= 0 ? startDelayRaw : 15000;
    const immediateTimer = setTimeout(() => {
      runBirthdayNotificationJob().catch(err => {
        console.error('[birthday_job] initial run failed', err);
      });
    }, startDelay);
    immediateTimer.unref?.();
  }

  scheduleNextRun();
}

export async function runBirthdayNotificationJob(
  input: Date | BirthdayJobOptions = new Date()
): Promise<BirthdayJobStats> {
  const options: BirthdayJobOptions = input instanceof Date ? { now: input } : (input ?? {});

  const {
    now = new Date(),
    targetEmails,
    targetDeviceIds,
    dryRun: dryRunOverride,
    skipWhatsApp = false,
    forceSend = false,
    suppressStateUpdates = false,
    reason,
    tenantId,
  } = options;

  const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
  const targetTenantId = normalizedTenantId || BIRTHDAY_DEFAULT_TENANT_ID;

  const stats: BirthdayJobStats = {
    totalDocuments: 0,
    matchedToday: 0,
    notifiedCount: 0,
    tokensSent: 0,
    alreadySent: 0,
    missingDateOfBirth: 0,
    noTokens: 0,
    skippedOptOut: 0,
    whatsappEnqueued: 0,
    whatsappFailed: 0,
    forcedRecipients: 0,
  };

  if (process.env.BIRTHDAY_NOTIFICATIONS_ENABLED === 'false') {
    console.log('[birthday_job] run skipped; disabled via env');
    return stats;
  }

  const envDryRun =
    process.env.TEST_MODE === '1' || process.env.BIRTHDAY_NOTIFICATIONS_DRY_RUN === 'true';
  const dryRun = dryRunOverride ?? envDryRun;

  ensureFirebase();
  const db = getFirestore();
  const globalCoachingName = await resolveCoachingName(db, targetTenantId);

  const normalizedEmailSet =
    targetEmails && targetEmails.length
      ? new Set(targetEmails.map(email => email.trim().toLowerCase()).filter(Boolean))
      : null;

  const targetDeviceIdSet =
    targetDeviceIds && targetDeviceIds.length
      ? new Set(targetDeviceIds.map(id => id.trim()).filter(Boolean))
      : null;

  if (
    reason ||
    normalizedEmailSet ||
    targetDeviceIdSet ||
    dryRunOverride !== undefined ||
    skipWhatsApp ||
    forceSend ||
    suppressStateUpdates
  ) {
    console.log('[birthday_job] trigger invoked', {
      reason: reason || 'unspecified',
      targetEmails: normalizedEmailSet ? Array.from(normalizedEmailSet) : undefined,
      targetDeviceIds: targetDeviceIdSet ? Array.from(targetDeviceIdSet) : undefined,
      dryRun,
      skipWhatsApp,
      forceSend,
      suppressStateUpdates,
      tenantId: normalizedTenantId || undefined,
    });
  }

  const istNow = toIST(now);
  const monthDayKey = formatMonthDay(istNow);
  const dateKey = formatDateKey(istNow);

  const rosterSnapshot = await loadBirthdayRoster(db, targetTenantId);
  stats.totalDocuments = rosterSnapshot.size;

  for (const doc of rosterSnapshot.docs) {
    const data = doc.data() as admin.firestore.DocumentData;
    const emailRaw = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
    if (!emailRaw) continue;

    if (normalizedEmailSet && !normalizedEmailSet.has(emailRaw)) {
      continue;
    }

    const monthDay = extractBirthdayMonthDay(data.dateOfBirth);
    if (!monthDay) {
      stats.missingDateOfBirth += 1;
      if (!forceSend) {
        continue;
      }
    }

    const isBirthdayToday = monthDay === monthDayKey;
    if (!isBirthdayToday && !forceSend) {
      continue;
    }

    if (data.birthdayNotificationsOptOut === true) {
      stats.skippedOptOut += 1;
      continue;
    }

    if (isBirthdayToday) {
      stats.matchedToday += 1;
    } else if (forceSend) {
      stats.forcedRecipients += 1;
    }

    const lastSentKey =
      typeof data.lastBirthdayNotificationDateKey === 'string'
        ? data.lastBirthdayNotificationDateKey
        : undefined;
    if (!forceSend && lastSentKey === dateKey) {
      stats.alreadySent += 1;
      continue;
    }

    const tokenRecords = await fetchExpoPushTokens(emailRaw, {
      targetDeviceIds: targetDeviceIdSet,
      tenantId: targetTenantId,
    });
    if (tokenRecords.length === 0) {
      stats.noTokens += 1;
      continue;
    }

    const baseDisplayName = deriveDisplayName(data, emailRaw);
    const displayName = applySalutation(baseDisplayName, data);
    const firstName = baseDisplayName.split(/\s+/)[0] || 'there';
    const senderName = globalCoachingName || data.coachingName || DEFAULT_TEAM_NAME;

    const title = templateTitle(firstName);
    const body = templateBody(displayName, senderName);

    let sentCount = 0;
    let failedCount = 0;

    const expoMessages: ExpoPushMessage[] = tokenRecords.map(record => ({
      to: record.token,
      title,
      body,
      sound: 'default',
      priority: 'high',
      data: {
        type: 'birthday_greeting',
        email: emailRaw,
        dateKey,
        sentAt: new Date().toISOString(),
        deviceId: record.deviceId,
      },
    }));

    if (dryRun) {
      sentCount = expoMessages.length;
      console.log('[birthday_job] dry-run -> would notify', {
        email: emailRaw,
        tokens: expoMessages.length,
        targetDeviceIds: targetDeviceIdSet ? Array.from(targetDeviceIdSet) : undefined,
      });
    } else {
      const result = await sendExpoMessages(expoMessages, { context: 'birthday_job' });
      sentCount = result.sent;
      failedCount = result.failed;

      if (result.invalidTokens?.length) {
        const invalidRecords = tokenRecords.filter(rec => result.invalidTokens.includes(rec.token));
        if (invalidRecords.length > 0) {
          await markPushTokensInvalid(invalidRecords, { context: 'birthday_job' });
        }
      }
    }

    stats.tokensSent += sentCount;
    if (sentCount > 0) stats.notifiedCount += 1;

    const whatsappRaw = extractWhatsappPhone(data);
    const whatsappRecipient = normalizeWhatsappPhone(whatsappRaw);

    if (!skipWhatsApp) {
      if (!whatsappRecipient) {
        console.log('[birthday_job] skipping WhatsApp birthday (no valid phone)', {
          email: emailRaw,
          phoneRaw: whatsappRaw ?? null,
        });
      } else {
        try {
          const whatsAppLanguage = determineWhatsappLanguage(data);
          if (dryRun) {
            console.log('[birthday_job] dry-run -> would enqueue WhatsApp birthday', {
              email: emailRaw,
              to: whatsappRecipient,
              language: whatsAppLanguage,
            });
            stats.whatsappEnqueued += 1;
          } else {
            enqueueBirthdayGreeting({
              to: whatsappRecipient,
              displayName,
              coachingName: senderName,
              language: whatsAppLanguage,
              mediaUrl: BIRTHDAY_WHATSAPP_IMAGE_URL,
              tenantId: normalizedTenantId || undefined,
            });
            stats.whatsappEnqueued += 1;
          }
        } catch (err) {
          stats.whatsappFailed += 1;
          console.warn('[birthday_job] failed to enqueue WhatsApp birthday', err instanceof Error ? err.message : err);
        }
      }
    } else {
      console.log('[birthday_job] skipping WhatsApp birthday enqueue (skipWhatsApp=true)', {
        email: emailRaw,
      });
    }

    const updatePayload: admin.firestore.DocumentData = {
      lastBirthdayNotificationAttemptedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastBirthdayNotificationAttemptedDateKey: dateKey,
      lastBirthdayNotificationAttemptedTokenCount: expoMessages.length,
      lastBirthdayNotificationDeliveredCount: sentCount,
      lastBirthdayNotificationFailedCount: failedCount,
    };

    if (!dryRun && sentCount > 0) {
      updatePayload.lastBirthdayNotificationDateKey = dateKey;
      updatePayload.lastBirthdayNotificationSentAt = admin.firestore.FieldValue.serverTimestamp();
      updatePayload.lastBirthdayNotificationSuccessCount = sentCount;
    }

    if (!suppressStateUpdates) {
      await doc.ref.set(updatePayload, { merge: true });
    }
  }

  if (process.env.BIRTHDAY_NOTIFICATIONS_LOG_STATS === 'true') {
    console.log('[birthday_job] completed', {
      dateKey,
      monthDayKey,
      ...stats,
    });
  }

  return stats;
}

async function resolveCoachingName(db: admin.firestore.Firestore, tenantId: string): Promise<string | null> {
  const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
  if (normalizedTenantId) {
    try {
      const metadata = await getTenantMetadata(normalizedTenantId);
      const tenantDisplayName = metadata.coachingName?.trim() || metadata.name?.trim();
      if (tenantDisplayName) {
        return tenantDisplayName;
      }
    } catch (err) {
      console.warn('[birthday_job] failed to load tenant metadata', err instanceof Error ? err.message : err);
    }
  }
  return resolveLegacyCoachingName(db);
}

async function resolveLegacyCoachingName(db: admin.firestore.Firestore): Promise<string | null> {
  const now = Date.now();
  if (cachedLegacyCoachingName && now < cachedLegacyCoachingName.expiresAt) {
    return cachedLegacyCoachingName.value;
  }

  try {
    const snap = await db.collection('appSettings').doc('globalSettings').get();
    let value: string | null = null;
    if (snap.exists) {
      const data = snap.data();
      const raw = typeof data?.coachingName === 'string' ? data.coachingName.trim() : '';
      value = raw || null;
    }
    const ttl = LEGACY_COACHING_NAME_CACHE_MS > 0 ? LEGACY_COACHING_NAME_CACHE_MS : 300_000;
    cachedLegacyCoachingName = { value, expiresAt: now + ttl };
    return value;
  } catch (err) {
    console.warn('[birthday_job] failed to load coaching name', err instanceof Error ? err.message : err);
    const ttl = Math.min(LEGACY_COACHING_NAME_CACHE_MS > 0 ? LEGACY_COACHING_NAME_CACHE_MS : 300_000, 60_000);
    cachedLegacyCoachingName = { value: null, expiresAt: now + ttl };
    return null;
  }
}

function scheduleNextRun(reference = new Date()): void {
  const delay = calculateDelayUntilNextMidnightIST(reference);
  scheduledTimer = setTimeout(() => {
    runBirthdayNotificationJob()
      .catch(err => console.error('[birthday_job] scheduled run failed', err))
      .finally(() => scheduleNextRun());
  }, delay);
  scheduledTimer.unref?.();
}

function calculateDelayUntilNextMidnightIST(now: Date = new Date()): number {
  const minutesPastMidnight = 1; // shift to 00:01 IST so birthday data is available
  const nowUtcMs = now.getTime() + now.getTimezoneOffset() * MS_PER_MINUTE;
  const istNow = new Date(nowUtcMs + IST_OFFSET_MINUTES * MS_PER_MINUTE);
  const nextIst = new Date(istNow);
  nextIst.setHours(24, minutesPastMidnight, 0, 0);
  const nextUtcMs = nextIst.getTime() - IST_OFFSET_MINUTES * MS_PER_MINUTE;
  const delay = nextUtcMs - now.getTime();
  if (!Number.isFinite(delay) || delay <= 1000) {
    return 60 * MS_PER_MINUTE; // fallback: 60 minutes
  }
  return delay;
}

function toIST(date: Date): Date {
  const utcMs = date.getTime() + date.getTimezoneOffset() * MS_PER_MINUTE;
  return new Date(utcMs + IST_OFFSET_MINUTES * MS_PER_MINUTE);
}

function formatMonthDay(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${month}-${day}`;
}

function formatDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function extractBirthdayMonthDay(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const direct = value.match(/^\d{2}-\d{2}$/);
    if (direct) return direct[0];
    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[2]}-${iso[3]}`;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return formatMonthDay(parsed);
    return null;
  }
  if (value instanceof Date) {
    return formatMonthDay(value);
  }
  const maybeTimestamp = value as { seconds?: number; nanoseconds?: number; toDate?: () => Date };
  if (typeof maybeTimestamp?.toDate === 'function') {
    const dt = maybeTimestamp.toDate();
    return formatMonthDay(dt);
  }
  if (typeof maybeTimestamp?.seconds === 'number') {
    const millis = maybeTimestamp.seconds * 1000 + Math.floor((maybeTimestamp.nanoseconds || 0) / 1e6);
    return formatMonthDay(new Date(millis));
  }
  return null;
}

function deriveDisplayName(data: admin.firestore.DocumentData, email: string): string {
  if (typeof data.displayName === 'string' && data.displayName.trim()) {
    return data.displayName.trim();
  }
  if (typeof data.name === 'string' && data.name.trim()) {
    return data.name.trim();
  }
  const raw = email.split('@')[0].replace(/[._-]/g, ' ');
  return raw.replace(/\s+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function applySalutation(name: string, data: admin.firestore.DocumentData): string {
  const salutation = extractSalutation(data);
  if (!salutation) return name;
  if (!name) return salutation;
  return `${salutation} ${name}`;
}

function extractSalutation(data: admin.firestore.DocumentData): string | null {
  const raw = typeof data.salutation === 'string' ? data.salutation.trim() : '';
  if (!raw) return null;
  return normalizeSalutation(raw);
}

function normalizeSalutation(value: string): string {
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const key = cleaned.replace(/\.+$/, '').toLowerCase();
  const lookup: Record<string, string> = {
    mr: 'Mr.',
    mrs: 'Mrs.',
    ms: 'Ms.',
    miss: 'Miss',
    dr: 'Dr.',
    prof: 'Prof.',
  };
  if (lookup[key]) return lookup[key];
  if (cleaned.includes(' ') || /\.$/.test(cleaned)) return cleaned;
  return `${cleaned}.`;
}

async function loadBirthdayRoster(
  db: admin.firestore.Firestore,
  tenantId: string
): Promise<admin.firestore.QuerySnapshot<admin.firestore.DocumentData>> {
  try {
    const snapshot = await db.collection(BIRTHDAY_PROFILE_COLLECTION).where('tenantId', '==', tenantId).get();
    if (!snapshot.empty || !BIRTHDAY_PROFILE_FALLBACK_ENABLED) {
      return snapshot;
    }
    console.warn(
      `[birthday_job] tenantProfiles empty for ${tenantId}; falling back to ${BIRTHDAY_FALLBACK_COLLECTION}`
    );
  } catch (error) {
    console.error('[birthday_job] failed to load tenantProfiles roster', error);
    if (!BIRTHDAY_PROFILE_FALLBACK_ENABLED) {
      throw error;
    }
  }
  return db.collection(BIRTHDAY_FALLBACK_COLLECTION).get();
}

async function fetchExpoPushTokens(
  email: string,
  options: { targetDeviceIds?: Set<string> | null; tenantId?: string | null } = {}
): Promise<PushTokenRecord[]> {
  const db = getFirestore();
  const tokens = new Map<string, { path: string; deviceId: string }>();
  const candidateIds = email === email.toLowerCase() ? [email] : [email, email.toLowerCase()];
  const rawTargetSet = options.targetDeviceIds;
  const targetDeviceIds = rawTargetSet instanceof Set && rawTargetSet.size > 0 ? rawTargetSet : null;
  const tenantId = typeof options.tenantId === 'string' ? options.tenantId.trim() : '';

  for (const docId of candidateIds) {
    try {
      const devicesSnap = await db.collection('user_devices').doc(docId).collection('devices').get();
      if (devicesSnap.empty) continue;

      devicesSnap.forEach(deviceDoc => {
        const deviceId = deviceDoc.id;
        if (targetDeviceIds && !targetDeviceIds.has(deviceId)) {
          return;
        }

        const payload = deviceDoc.data();
        if (tenantId && !matchesTenantDevice(payload, tenantId)) {
          return;
        }
        const tokenRaw = typeof payload.expoPushToken === 'string' ? payload.expoPushToken.trim() : '';
        if (!tokenRaw) return;
        if (payload.isDeleted === true) return;
        if (payload.notificationsEnabled === false) return;
        if (payload.pushTokenStatus === 'missing') return;
        const isExpoToken = /^(ExponentPushToken|ExpoPushToken)/i.test(tokenRaw);
        if (!isExpoToken) return;
        tokens.set(tokenRaw, { path: deviceDoc.ref.path, deviceId });
      });
    } catch (err) {
      console.warn('[birthday_job] failed to read user_devices for', docId, err instanceof Error ? err.message : err);
    }
  }

  return Array.from(tokens.entries()).map(([token, meta]) => ({
    token,
    deviceDocPath: meta.path,
    deviceId: meta.deviceId,
    ownerEmail: email,
  }));
}

function determineWhatsappLanguage(data: admin.firestore.DocumentData): 'english' | 'hindi' | 'bilingual_en_hi' {
  const pref = typeof data?.birthdayLanguagePreference === 'string' ? data.birthdayLanguagePreference.toLowerCase() : '';
  if (pref === 'english') return 'english';
  if (pref === 'hindi') return 'hindi';
  if (pref === 'bilingual' || pref === 'bilingual_en_hi') return 'bilingual_en_hi';
  return 'bilingual_en_hi';
}

function extractWhatsappPhone(data: admin.firestore.DocumentData): string | null {
  const candidateKeys = [
    'whatsappNumber',
    'whatsapp',
    'phone',
    'phoneNumber',
    'contactNumber',
    'mobile',
    'mobileNumber',
  ];

  for (const key of candidateKeys) {
    const value = data?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function normalizeWhatsappPhone(input: unknown): string | null {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  let digits = raw.startsWith('+') ? raw.slice(1) : raw;
  digits = digits.replace(/\D/g, '');
  if (!digits) return null;

  digits = digits.replace(/^0+/, '');
  if (!digits) return null;

  if (digits.length === 10) {
    digits = `${DEFAULT_WHATSAPP_COUNTRY_CODE}${digits}`;
  }

  if (digits.length < 11 || digits.length > 15) {
    return null;
  }

  return digits;
}

function templateTitle(firstName: string): string {
  return `Happy Birthday ${firstName}!`;
}

function templateBody(displayName: string, senderName: string): string {
  const parts = [`Wishing you a wonderful year ahead, ${displayName}.`];
  if (senderName) {
    parts.push(`Warm wishes from ${senderName}.`);
  }
  return parts.join(' ');
}
