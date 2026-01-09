import fetch from 'node-fetch';
import * as admin from 'firebase-admin';
import { ensureFirebase, getFirestore } from './firebaseAdmin';
import { DAILY_QUOTES_LIBRARY } from './dailyQuotesLibrary';
import { sendExpoMessages, markPushTokensInvalid, ExpoPushMessage, PushTokenRecord } from './pushUtils';
import { matchesTenantDevice } from './tenantDeviceFilter';

export type DailyQuoteTimeOfDay = 'morning' | 'evening' | 'immediate';
export interface Quote {
  text: string;
  author: string;
  category: string;
  source?: 'local' | 'quotable' | 'zenquotes' | 'quotegarden';
  id?: string;
}

export interface DailyQuoteJobOptions {
  now?: Date;
  timeOfDay?: DailyQuoteTimeOfDay | 'auto';
  targetEmails?: string[];
  dryRun?: boolean;
  reason?: string;
  tenantId?: string;
}

export interface DailyQuoteJobStats {
  runStartedAt: string;
  runCompletedAt: string;
  dryRun: boolean;
  reason: string;
  totalUserDocs: number;
  totalDevices: number;
  eligibleDevices: number;
  attemptedDeliveries: number;
  sent: number;
  failed: number;
  skipped: {
    notificationsDisabled: number;
    dailyQuotesDisabled: number;
    missingToken: number;
    webDevice: number;
    duplicateToken: number;
    outsideWindow: number;
    deletedDevice: number;
  };
  timeOfDayBreakdown: Record<DailyQuoteTimeOfDay, { attempted: number; sent: number }>;
  quote: Quote;
  recipientsSample: { userEmail: string; deviceId: string; timeOfDay: DailyQuoteTimeOfDay; timezone?: string }[];
}

export interface DailyQuoteSchedulerStatus {
  enabled: boolean;
  schedulerStarted: boolean;
  schedulerMode: 'interval' | 'time_of_day';
  intervalMs: number;
  windowMinutes: number;
  nextRunAt: string | null;
  nextRunByTimeOfDay?: Partial<Record<Exclude<DailyQuoteTimeOfDay, 'immediate' | 'auto'>, string | null>>;
  lastRunAt: string | null;
  isRunning: boolean;
  lastRunStats: DailyQuoteJobStats | null;
}

const DEFAULT_TIMEZONE = process.env.DAILY_QUOTES_DEFAULT_TIMEZONE || 'Asia/Kolkata';
const DEBUG_PUSH_TOKEN = (process.env.DAILY_QUOTES_DEBUG_TOKEN || '').trim();
const DEBUG_DEVICE_ID = (process.env.DAILY_QUOTES_DEBUG_DEVICE_ID || '').trim();
const DEBUG_EMAIL = (process.env.DAILY_QUOTES_DEBUG_EMAIL || '').trim().toLowerCase();
const MORNING_HOUR = normalizeNumericEnv(process.env.DAILY_QUOTES_MORNING_HOUR, 8, 0, 23);
const MORNING_MINUTE = normalizeNumericEnv(process.env.DAILY_QUOTES_MORNING_MINUTE, 0, 0, 59);
const EVENING_HOUR = normalizeNumericEnv(process.env.DAILY_QUOTES_EVENING_HOUR, 20, 0, 23);
const EVENING_MINUTE = normalizeNumericEnv(process.env.DAILY_QUOTES_EVENING_MINUTE, 0, 0, 59);
const WINDOW_MINUTES = normalizeNumericEnv(process.env.DAILY_QUOTES_WINDOW_MINUTES, 90, 1, 180);
const WINDOW_EARLY_GRACE_SECONDS = normalizeNumericEnv(process.env.DAILY_QUOTES_WINDOW_EARLY_GRACE_SECONDS, 10, 0, 300);
const SCHEDULER_INTERVAL_MS = normalizeNumericEnv(process.env.DAILY_QUOTES_INTERVAL_MS, 5 * 60_000, 60_000, 6 * 60 * 60 * 1000);
const API_TIMEOUT_MS = normalizeNumericEnv(process.env.DAILY_QUOTES_API_TIMEOUT_MS, 5000, 1000, 20000);
const IS_TEST_PROCESS = process.env.TEST_MODE === '1' || process.argv.includes('--test');
const CATCHUP_ON_START =
  !IS_TEST_PROCESS && (process.env.DAILY_QUOTES_CATCHUP_ON_START ?? 'true').toLowerCase() === 'true';
const CATCHUP_DELAY_MS = normalizeNumericEnv(process.env.DAILY_QUOTES_CATCHUP_DELAY_MS, 10_000, 0, 120_000);
const SCHEDULER_MODE: 'interval' | 'time_of_day' = (process.env.DAILY_QUOTES_SCHEDULER_MODE ?? 'time_of_day').toLowerCase() === 'interval'
  ? 'interval'
  : 'time_of_day';
type ScheduledSlot = Extract<DailyQuoteTimeOfDay, 'morning' | 'evening'>;
const SLOT_SEQUENCE: ScheduledSlot[] = ['morning', 'evening'];

function detectCatchupSlot(now: Date, timezone: string): ScheduledSlot | null {
  const local = resolveLocalTime(now, timezone);
  const localSeconds = local.hour * 60 * 60 + local.minute * 60 + local.second;
  const windows: { key: ScheduledSlot; hour: number; minute: number }[] = [
    { key: 'morning', hour: MORNING_HOUR, minute: MORNING_MINUTE },
    { key: 'evening', hour: EVENING_HOUR, minute: EVENING_MINUTE },
  ];

  for (const window of windows) {
    const targetSeconds = window.hour * 60 * 60 + window.minute * 60;
    if (isWithinWindowSeconds(localSeconds, targetSeconds, WINDOW_MINUTES, WINDOW_EARLY_GRACE_SECONDS)) {
      return window.key;
    }
  }
  return null;
}

let schedulerStarted = false;
let schedulerTimer: NodeJS.Timeout | null = null;
let nextRunAt: Date | null = null;
let lastRunAt: Date | null = null;
let lastRunStats: DailyQuoteJobStats | null = null;
let runningPromise: Promise<DailyQuoteJobStats> | null = null;
const slotTimers: Partial<Record<ScheduledSlot, NodeJS.Timeout | null>> = { morning: null, evening: null };
const nextSlotRunAt: Partial<Record<ScheduledSlot, Date | null>> = { morning: null, evening: null };

interface PendingDelivery {
  ref: admin.firestore.DocumentReference<admin.firestore.DocumentData>;
  devicePath: string;
  timeOfDay: DailyQuoteTimeOfDay;
  dateKey: string;
}

export function startDailyQuoteScheduler(): void {
  if (process.env.DAILY_QUOTES_ENABLED === 'false') {
    console.log('[daily_quote_job] scheduler disabled via env');
    return;
  }

  if (schedulerStarted) return;
  schedulerStarted = true;

  const runOnStart = (process.env.DAILY_QUOTES_RUN_ON_START ?? 'false').toLowerCase() === 'true';
  if (runOnStart) {
    const startDelayRaw = normalizeNumericEnv(process.env.DAILY_QUOTES_START_DELAY_MS, 15_000, 0, 120_000);
    const timer = setTimeout(() => {
      runDailyQuoteJob({ reason: 'startup' }).catch(err => {
        console.error('[daily_quote_job] initial run failed', err);
      });
    }, startDelayRaw);
    timer.unref?.();
  }

  if (!runOnStart && CATCHUP_ON_START && SCHEDULER_MODE === 'time_of_day') {
    const now = new Date();
    const catchupSlot = detectCatchupSlot(now, DEFAULT_TIMEZONE);
    if (catchupSlot) {
      console.log('[daily_quote_job] scheduling catch-up run on start', {
        slot: catchupSlot,
        now: now.toISOString(),
        timezone: DEFAULT_TIMEZONE,
        windowMinutes: WINDOW_MINUTES,
        delayMs: CATCHUP_DELAY_MS,
      });
      const timer = setTimeout(() => {
        runDailyQuoteJob({ reason: `catchup:${catchupSlot}`, timeOfDay: catchupSlot }).catch(err => {
          console.error('[daily_quote_job] catch-up run failed', err);
        });
      }, CATCHUP_DELAY_MS);
      timer.unref?.();
    }
  }

  if (SCHEDULER_MODE === 'interval') {
    if (SCHEDULER_INTERVAL_MS > 0) {
      scheduleNextIntervalRun();
    }
  } else {
    scheduleAllSlotRuns();
  }
}

export function stopDailyQuoteScheduler(): void {
  schedulerStarted = false;
  if (schedulerTimer) {
    clearTimeout(schedulerTimer);
    schedulerTimer = null;
  }
  clearSlotTimers();
  nextRunAt = null;
}

function scheduleNextIntervalRun(): void {
  if (SCHEDULER_INTERVAL_MS <= 0 || process.env.DAILY_QUOTES_ENABLED === 'false') {
    return;
  }
  nextRunAt = new Date(Date.now() + SCHEDULER_INTERVAL_MS);
  schedulerTimer = setTimeout(() => {
    schedulerTimer = null;
    runDailyQuoteJob({ reason: 'interval' })
      .catch(err => console.error('[daily_quote_job] scheduled run failed', err))
      .finally(() => {
        if (schedulerStarted) {
          scheduleNextIntervalRun();
        }
      });
  }, SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref?.();
}

function scheduleAllSlotRuns(reference = new Date()): void {
  if (process.env.DAILY_QUOTES_ENABLED === 'false') {
    return;
  }
  SLOT_SEQUENCE.forEach(slot => scheduleTimeOfDayRun(slot, reference));
}

function scheduleTimeOfDayRun(timeOfDay: ScheduledSlot, reference = new Date()): void {
  if (process.env.DAILY_QUOTES_ENABLED === 'false') {
    return;
  }
  const delay = calculateDelayUntilTimeOfDay(timeOfDay, reference);
  const scheduledFor = new Date(reference.getTime() + delay);
  nextSlotRunAt[timeOfDay] = scheduledFor;
  updateNextRunFromSlots();
  console.log('[daily_quote_job] scheduled slot run', {
    slot: timeOfDay,
    scheduledFor: scheduledFor.toISOString(),
    delayMs: delay,
  });

  const timer = setTimeout(() => {
    slotTimers[timeOfDay] = null;
    nextSlotRunAt[timeOfDay] = null;
    updateNextRunFromSlots();

    console.log('[daily_quote_job] slot timer triggered', {
      slot: timeOfDay,
      triggeredAt: new Date().toISOString(),
    });

    runDailyQuoteJob({ reason: `slot:${timeOfDay}`, timeOfDay })
      .catch(err => console.error(`[daily_quote_job] ${timeOfDay} run failed`, err))
      .finally(() => {
        if (schedulerStarted) {
          scheduleTimeOfDayRun(timeOfDay);
        }
      });
  }, delay);

  timer.unref?.();
  slotTimers[timeOfDay] = timer;
}

function clearSlotTimers(): void {
  SLOT_SEQUENCE.forEach(slot => {
    const timer = slotTimers[slot];
    if (timer) {
      clearTimeout(timer);
    }
    slotTimers[slot] = null;
    nextSlotRunAt[slot] = null;
  });
  updateNextRunFromSlots();
}

function updateNextRunFromSlots(): void {
  if (SCHEDULER_MODE !== 'time_of_day') {
    return;
  }
  const upcoming = SLOT_SEQUENCE.map(slot => nextSlotRunAt[slot]).filter((date): date is Date => date instanceof Date);
  if (upcoming.length === 0) {
    nextRunAt = null;
    return;
  }
  upcoming.sort((a, b) => a.getTime() - b.getTime());
  nextRunAt = upcoming[0];
}

function calculateDelayUntilTimeOfDay(timeOfDay: ScheduledSlot, reference = new Date(), timezone: string = DEFAULT_TIMEZONE): number {
  const targetHour = timeOfDay === 'morning' ? MORNING_HOUR : EVENING_HOUR;
  const targetMinute = timeOfDay === 'morning' ? MORNING_MINUTE : EVENING_MINUTE;
  const localParts = resolveLocalDateParts(reference, timezone);
  const targetLocal: LocalDateParts = {
    year: localParts.year,
    month: localParts.month,
    day: localParts.day,
    hour: targetHour,
    minute: targetMinute,
    second: 0,
  };

  let targetUtcMs = convertLocalDateToUtcMs(targetLocal, timezone);
  if (targetUtcMs <= reference.getTime()) {
    const tomorrowReference = new Date(reference.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowParts = resolveLocalDateParts(tomorrowReference, timezone);
    const tomorrowLocal: LocalDateParts = {
      year: tomorrowParts.year,
      month: tomorrowParts.month,
      day: tomorrowParts.day,
      hour: targetHour,
      minute: targetMinute,
      second: 0,
    };
    targetUtcMs = convertLocalDateToUtcMs(tomorrowLocal, timezone);
  }

  const delay = targetUtcMs - reference.getTime();
  if (!Number.isFinite(delay) || delay <= 0) {
    return 60_000;
  }
  return delay;
}

export async function runDailyQuoteJob(options: DailyQuoteJobOptions = {}): Promise<DailyQuoteJobStats> {
  if (process.env.DAILY_QUOTES_ENABLED === 'false') {
    const now = options.now ? new Date(options.now) : new Date();
    return {
      runStartedAt: now.toISOString(),
      runCompletedAt: now.toISOString(),
      dryRun: Boolean(options.dryRun),
      reason: options.reason ?? 'disabled',
      totalUserDocs: 0,
      totalDevices: 0,
      eligibleDevices: 0,
      attemptedDeliveries: 0,
      sent: 0,
      failed: 0,
      skipped: {
        notificationsDisabled: 0,
        dailyQuotesDisabled: 0,
        missingToken: 0,
        webDevice: 0,
        duplicateToken: 0,
        outsideWindow: 0,
        deletedDevice: 0,
      },
      timeOfDayBreakdown: {
        morning: { attempted: 0, sent: 0 },
        evening: { attempted: 0, sent: 0 },
        immediate: { attempted: 0, sent: 0 },
      },
      quote: pickLocalQuote(),
      recipientsSample: [],
    };
  }

  if (runningPromise) {
    await runningPromise;
  }

  const execution = executeDailyQuoteJob(options);
  runningPromise = execution;

  try {
    const stats = await execution;
    lastRunAt = new Date(stats.runCompletedAt);
    lastRunStats = stats;
    return stats;
  } finally {
    runningPromise = null;
  }
}

export function getDailyQuoteSchedulerStatus(): DailyQuoteSchedulerStatus {
  const nextRunByTimeOfDay =
    SCHEDULER_MODE === 'time_of_day'
      ? {
          morning: nextSlotRunAt.morning ? nextSlotRunAt.morning.toISOString() : null,
          evening: nextSlotRunAt.evening ? nextSlotRunAt.evening.toISOString() : null,
        }
      : undefined;

  return {
    enabled: process.env.DAILY_QUOTES_ENABLED !== 'false',
    schedulerStarted,
    schedulerMode: SCHEDULER_MODE,
    intervalMs: SCHEDULER_MODE === 'interval' ? SCHEDULER_INTERVAL_MS : 0,
    windowMinutes: WINDOW_MINUTES,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    nextRunByTimeOfDay,
    lastRunAt: lastRunAt ? lastRunAt.toISOString() : null,
    isRunning: Boolean(runningPromise),
    lastRunStats,
  };
}

async function executeDailyQuoteJob(options: DailyQuoteJobOptions): Promise<DailyQuoteJobStats> {
  ensureFirebase();
  const db = getFirestore();
  const startedAt = options.now ? new Date(options.now) : new Date();
  const now = startedAt;
  const dryRun = Boolean(options.dryRun);
  const reason = options.reason ?? 'manual';
  const requestedTimeOfDay = options.timeOfDay ?? 'auto';
  const tenantId = typeof options.tenantId === 'string' ? options.tenantId.trim() : '';
  const logMetaBase = {
    reason,
    requestedTimeOfDay,
    dryRun,
    targetEmailsCount: options.targetEmails?.length ?? 0,
    tenantId: tenantId || undefined,
  };
  console.log('[daily_quote_job] execution start', {
    ...logMetaBase,
    startedAt: startedAt.toISOString(),
  });

  const quote = await selectQuote();

  const stats: DailyQuoteJobStats = {
    runStartedAt: startedAt.toISOString(),
    runCompletedAt: '',
    dryRun,
    reason,
    totalUserDocs: 0,
    totalDevices: 0,
    eligibleDevices: 0,
    attemptedDeliveries: 0,
    sent: 0,
    failed: 0,
    skipped: {
      notificationsDisabled: 0,
      dailyQuotesDisabled: 0,
      missingToken: 0,
      webDevice: 0,
      duplicateToken: 0,
      outsideWindow: 0,
      deletedDevice: 0,
    },
    timeOfDayBreakdown: {
      morning: { attempted: 0, sent: 0 },
      evening: { attempted: 0, sent: 0 },
      immediate: { attempted: 0, sent: 0 },
    },
    quote,
    recipientsSample: [],
  };

  let messages: ExpoPushMessage[] = [];
  let pendingDeliveries: PendingDelivery[] = [];
  let tokenRecords: PushTokenRecord[] = [];
  const tokenRecordByToken = new Map<string, PushTokenRecord>();
  const tokensSeen = new Set<string>();
  const disabledTokens = new Set<string>();
  const messageIndexByToken = new Map<string, number>();
  let messageMeta: { timeOfDay: DailyQuoteTimeOfDay; userEmail: string; deviceId: string; timezone: string }[] = [];
  const suppressedMessageIndices = new Set<number>();
  const tokenPreferenceState = new Map<string, { state: 'enabled' | 'disabled'; timestamp: number; messageIndex?: number }>();
  const tokenFirstSeenMeta = new Map<string, { userEmail: string; deviceId: string; devicePath: string; timestamp: number }>();

  const targetEmails = options.targetEmails ? Array.from(new Set(options.targetEmails.map(normalizeEmail))).filter(Boolean) : null;

  const processDeviceDocs = async (
    userEmail: string,
    deviceDocs: admin.firestore.QueryDocumentSnapshot<admin.firestore.DocumentData>[]
  ) => {
    const scopedDeviceDocs = tenantId
      ? deviceDocs.filter(doc => matchesTenantDevice(doc.data() || {}, tenantId))
      : deviceDocs;
    stats.totalDevices += scopedDeviceDocs.length;

    const resolvePreferenceTimestamp = (data: admin.firestore.DocumentData): number => {
      const candidates = [
        toMillis(data.preferencesSyncedAt),
        toMillis(data.updatedAt),
        toMillis(data.lastSeen),
        toMillis(data.lastHeartbeatAt),
        toMillis(data.createdAt),
      ];
      for (const value of candidates) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          return value;
        }
      }
      return 0;
    };

    const suppressToken = (token: string | null | undefined, timestamp: number) => {
      if (!token) return;
      const existing = tokenPreferenceState.get(token);
      if (existing && existing.timestamp > timestamp) {
        // A newer preference already exists; ignore this suppression.
        return;
      }

      if (DEBUG_PUSH_TOKEN && token === DEBUG_PUSH_TOKEN) {
        console.log('[daily_quote_job] debug suppressToken', {
          token,
          userEmail,
          timestamp,
          existing,
        });
      }

      disabledTokens.add(token);
      tokenPreferenceState.set(token, { state: 'disabled', timestamp });

      if (existing && typeof existing.messageIndex === 'number') {
        suppressedMessageIndices.add(existing.messageIndex);
        messageIndexByToken.delete(token);
      }
      tokensSeen.delete(token);
    };

    const orderedDeviceDocs = [...scopedDeviceDocs].sort((a, b) => {
      const aTs = resolvePreferenceTimestamp(a.data() || {});
      const bTs = resolvePreferenceTimestamp(b.data() || {});
      return bTs - aTs;
    });

    for (const deviceDoc of orderedDeviceDocs) {
      const deviceData = deviceDoc.data() || {};
      const deviceId = deviceDoc.id;
      const expoPushTokenRaw = typeof deviceData.expoPushToken === 'string' ? deviceData.expoPushToken.trim() : '';
      const preferenceTimestamp = resolvePreferenceTimestamp(deviceData);

      const debugMatch =
        (DEBUG_EMAIL && userEmail === DEBUG_EMAIL) ||
        (DEBUG_DEVICE_ID && deviceId === DEBUG_DEVICE_ID) ||
        (DEBUG_PUSH_TOKEN && expoPushTokenRaw && expoPushTokenRaw === DEBUG_PUSH_TOKEN);

      if (deviceData.isDeleted === true) {
        stats.skipped.deletedDevice += 1;
        suppressToken(expoPushTokenRaw, preferenceTimestamp);
        if (debugMatch) {
          console.log('[daily_quote_job] debug skipped deletedDevice', {
            userEmail,
            deviceId,
            token: expoPushTokenRaw,
            preferenceTimestamp,
          });
        }
        continue;
      }

      if ((deviceData.deviceType || '').toLowerCase() === 'web') {
        stats.skipped.webDevice += 1;
        if (debugMatch) {
          console.log('[daily_quote_job] debug skipped webDevice', { userEmail, deviceId, token: expoPushTokenRaw });
        }
        continue;
      }

      if (deviceData.notificationsEnabled === false) {
        stats.skipped.notificationsDisabled += 1;
        suppressToken(expoPushTokenRaw, preferenceTimestamp);
        if (debugMatch) {
          console.log('[daily_quote_job] debug skipped notificationsDisabled', {
            userEmail,
            deviceId,
            token: expoPushTokenRaw,
            preferenceTimestamp,
          });
        }
        continue;
      }

      if (deviceData.dailyQuotesEnabled === false) {
        stats.skipped.dailyQuotesDisabled += 1;
        suppressToken(expoPushTokenRaw, preferenceTimestamp);
        if (debugMatch) {
          console.log('[daily_quote_job] debug skipped dailyQuotesDisabled', {
            userEmail,
            deviceId,
            token: expoPushTokenRaw,
            preferenceTimestamp,
          });
        }
        continue;
      }

      if (!expoPushTokenRaw) {
        stats.skipped.missingToken += 1;
        if (debugMatch) {
          console.log('[daily_quote_job] debug skipped missingToken', { userEmail, deviceId });
        }
        continue;
      }

      if (disabledTokens.has(expoPushTokenRaw)) {
        const state = tokenPreferenceState.get(expoPushTokenRaw);
        if (state && state.state === 'disabled' && state.timestamp >= preferenceTimestamp) {
          if (debugMatch) {
            console.log('[daily_quote_job] debug skipped tokenSuppressedByNewerDisable', {
              userEmail,
              deviceId,
              token: expoPushTokenRaw,
              preferenceTimestamp,
              state,
            });
          }
          continue;
        }
        disabledTokens.delete(expoPushTokenRaw);
      }

      if (tokensSeen.has(expoPushTokenRaw)) {
        const existing = tokenPreferenceState.get(expoPushTokenRaw);
        // Important: a token can appear in multiple device docs (multi-login, stale docs, etc).
        // Prefer the newest *enabled* record, otherwise the wrong device can "win" and the
        // intended device will never receive the daily quote.
        const canReplace =
          existing &&
          existing.state === 'enabled' &&
          typeof existing.timestamp === 'number' &&
          existing.timestamp < preferenceTimestamp;

        if (canReplace) {
          if (typeof existing.messageIndex === 'number') {
            suppressedMessageIndices.add(existing.messageIndex);
          }
          messageIndexByToken.delete(expoPushTokenRaw);
          tokensSeen.delete(expoPushTokenRaw);
          if (debugMatch) {
            console.log('[daily_quote_job] debug duplicateToken replacedByNewer', {
              userEmail,
              deviceId,
              token: expoPushTokenRaw,
              previous: existing,
              preferenceTimestamp,
              previousFirstSeen: tokenFirstSeenMeta.get(expoPushTokenRaw),
            });
          }
        } else {
          stats.skipped.duplicateToken += 1;
          if (debugMatch) {
            console.log('[daily_quote_job] debug skipped duplicateToken', {
              userEmail,
              deviceId,
              token: expoPushTokenRaw,
              preferenceTimestamp,
              existing,
              firstSeen: tokenFirstSeenMeta.get(expoPushTokenRaw),
            });
          }
          continue;
        }
      }

      const timezoneRaw = typeof deviceData.timezone === 'string' ? deviceData.timezone.trim() : '';
      const timezone = timezoneRaw || DEFAULT_TIMEZONE;

      const due = evaluateDeliveryWindow(now, timezone, deviceData, requestedTimeOfDay);
      if (!due) {
        stats.skipped.outsideWindow += 1;
        if (debugMatch) {
          const local = resolveLocalTime(now, timezone);
          const localMinutes = local.hour * 60 + local.minute;
          const morningTarget = MORNING_HOUR * 60 + MORNING_MINUTE;
          const eveningTarget = EVENING_HOUR * 60 + EVENING_MINUTE;
          console.log('[daily_quote_job] debug skipped outsideWindow', {
            userEmail,
            deviceId,
            token: expoPushTokenRaw,
            timezone,
            requestedTimeOfDay,
            local,
            localMinutes,
            morningDiff: localMinutes - morningTarget,
            eveningDiff: localMinutes - eveningTarget,
            windowMinutes: WINDOW_MINUTES,
            lastMorning: deviceData.lastDailyQuoteMorningDateKey,
            lastEvening: deviceData.lastDailyQuoteEveningDateKey,
          });
        }
        continue;
      }
      tokensSeen.add(expoPushTokenRaw);

      stats.eligibleDevices += 1;
      stats.attemptedDeliveries += 1;
      stats.timeOfDayBreakdown[due.timeOfDay].attempted += 1;

      if (stats.recipientsSample.length < 20) {
        stats.recipientsSample.push({
          userEmail,
          deviceId,
          timeOfDay: due.timeOfDay,
          timezone,
        });
      }

      const body = composeQuoteBody(quote);
      const dataPayload = {
        type: 'daily_quote',
        time: due.timeOfDay,
        category: quote.category,
        author: quote.author,
        source: quote.source ?? 'local',
        quote: quote.text,
      };

      const message: ExpoPushMessage = {
        to: expoPushTokenRaw,
        sound: 'default',
        priority: 'high',
        title: 'Daily Quote',
        body,
        channelId: 'daily_quotes',
        data: dataPayload,
      };

      const messageIndex = messages.length;
      messages.push(message);
      messageIndexByToken.set(expoPushTokenRaw, messageIndex);
      messageMeta.push({ timeOfDay: due.timeOfDay, userEmail, deviceId, timezone });

      const devicePath = `user_devices/${userEmail}/devices/${deviceId}`;
      const record: PushTokenRecord = { token: expoPushTokenRaw, deviceDocPath: devicePath };
      tokenRecords.push(record);
      tokenRecordByToken.set(expoPushTokenRaw, record);

      if (!tokenFirstSeenMeta.has(expoPushTokenRaw)) {
        tokenFirstSeenMeta.set(expoPushTokenRaw, { userEmail, deviceId, devicePath, timestamp: preferenceTimestamp });
      }

      tokenPreferenceState.set(expoPushTokenRaw, {
        state: 'enabled',
        timestamp: preferenceTimestamp,
        messageIndex,
      });

      pendingDeliveries.push({
        ref: deviceDoc.ref,
        devicePath,
        timeOfDay: due.timeOfDay,
        dateKey: due.dateKey,
      });
    }
  };

  if (targetEmails && targetEmails.length > 0) {
    stats.totalUserDocs = targetEmails.length;
    for (const email of targetEmails) {
      const docRef = db.collection('user_devices').doc(email);
      const docSnap = await docRef.get();
      if (!docSnap.exists) continue;
      const devicesSnap = await docRef.collection('devices').get();
      await processDeviceDocs(email, devicesSnap.docs);
    }
  } else {
    const snapshot = await db.collection('user_devices').get();
    stats.totalUserDocs = snapshot.size;
    for (const doc of snapshot.docs) {
      const userEmail = normalizeEmail(doc.id);
      const devicesSnap = await doc.ref.collection('devices').get();
      await processDeviceDocs(userEmail, devicesSnap.docs);
    }
  }

  if (suppressedMessageIndices.size > 0) {
    const filteredMessages: ExpoPushMessage[] = [];
    const filteredDeliveries: PendingDelivery[] = [];
    const filteredTokenRecords: PushTokenRecord[] = [];
    const filteredMeta: typeof messageMeta = [];

    messages.forEach((msg, idx) => {
      if (suppressedMessageIndices.has(idx)) {
        return;
      }
      filteredMessages.push(msg);
      filteredDeliveries.push(pendingDeliveries[idx]);
      filteredTokenRecords.push(tokenRecords[idx]);
      filteredMeta.push(messageMeta[idx]);
    });

    messages = filteredMessages;
    pendingDeliveries = filteredDeliveries;
    tokenRecords = filteredTokenRecords;
    messageMeta = filteredMeta;
    tokenRecordByToken.clear();
    tokenRecords.forEach(record => tokenRecordByToken.set(record.token, record));
  }

  stats.attemptedDeliveries = messages.length;
  stats.eligibleDevices = messages.length;
  stats.timeOfDayBreakdown = {
    morning: { attempted: 0, sent: 0 },
    evening: { attempted: 0, sent: 0 },
    immediate: { attempted: 0, sent: 0 },
  };

  const activeDeviceKeys = new Set<string>();
  messageMeta.forEach(meta => {
    if (!meta) return;
    stats.timeOfDayBreakdown[meta.timeOfDay].attempted += 1;
    activeDeviceKeys.add(`${meta.userEmail}::${meta.deviceId}`);
  });

  if (stats.recipientsSample.length > 0) {
    stats.recipientsSample = stats.recipientsSample.filter(entry =>
      activeDeviceKeys.has(`${entry.userEmail}::${entry.deviceId}`)
    );
  }

  if (messages.length > 0) {
    if (dryRun) {
      stats.sent = messages.length;
      stats.timeOfDayBreakdown.morning.sent += stats.timeOfDayBreakdown.morning.attempted;
      stats.timeOfDayBreakdown.evening.sent += stats.timeOfDayBreakdown.evening.attempted;
      stats.timeOfDayBreakdown.immediate.sent += stats.timeOfDayBreakdown.immediate.attempted;
    } else {
      const result = await sendExpoMessages(messages, { context: 'daily_quote_job' });
      stats.sent = result.sent;
      stats.failed = result.failed;
      if (result.invalidTokens.length > 0) {
        const invalidRecords = result.invalidTokens
          .map(token => tokenRecordByToken.get(token))
          .filter((record): record is PushTokenRecord => Boolean(record));
        if (invalidRecords.length > 0) {
          await markPushTokensInvalid(invalidRecords, { context: 'daily_quote_job' });
        }
      }
      stats.timeOfDayBreakdown.morning.sent += stats.timeOfDayBreakdown.morning.attempted;
      stats.timeOfDayBreakdown.evening.sent += stats.timeOfDayBreakdown.evening.attempted;
      stats.timeOfDayBreakdown.immediate.sent += stats.timeOfDayBreakdown.immediate.attempted;
    }
  }

  if (!dryRun && pendingDeliveries.length > 0) {
    await commitPendingUpdates(db, pendingDeliveries, quote);
  }

  stats.runCompletedAt = new Date().toISOString();
  console.log('[daily_quote_job] execution complete', {
    ...logMetaBase,
    durationMs: new Date(stats.runCompletedAt).getTime() - startedAt.getTime(),
    attempted: stats.attemptedDeliveries,
    sent: stats.sent,
    failed: stats.failed,
    recipientsSample: stats.recipientsSample.length,
  });
  return stats;
}

async function commitPendingUpdates(
  db: admin.firestore.Firestore,
  pending: PendingDelivery[],
  quote: Quote
): Promise<void> {
  if (pending.length === 0) return;

  let batch = db.batch();
  let batchCount = 0;

  const flush = async () => {
    if (batchCount === 0) return;
    await batch.commit();
    batch = db.batch();
    batchCount = 0;
  };

  for (const item of pending) {
    const update: Record<string, unknown> = {
      lastDailyQuoteQueuedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastDailyQuoteQueuedTimeOfDay: item.timeOfDay,
      lastDailyQuoteQuote: quote.text,
      lastDailyQuoteAuthor: quote.author,
      lastDailyQuoteCategory: quote.category,
      lastDailyQuoteSource: quote.source ?? 'local',
      lastDailyQuoteDateKey: item.dateKey,
    };

    if (item.timeOfDay === 'morning') {
      (update as any).lastDailyQuoteMorningDateKey = item.dateKey;
    } else if (item.timeOfDay === 'evening') {
      (update as any).lastDailyQuoteEveningDateKey = item.dateKey;
    } else {
      (update as any).lastDailyQuoteImmediateDateKey = item.dateKey;
    }

    batch.set(item.ref, update, { merge: true });
    batchCount += 1;

    if (batchCount >= 400) {
      await flush();
    }
  }

  await flush();
}

function toMillis(input: any): number | null {
  if (input == null) return null;
  if (typeof input === 'number') {
    return Number.isFinite(input) ? input : null;
  }
  if (typeof input === 'string') {
    const parsedDate = Date.parse(input);
    if (!Number.isNaN(parsedDate)) {
      return parsedDate;
    }
    const numeric = Number(input);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (input instanceof Date) {
    return input.getTime();
  }
  if (typeof input === 'object') {
    const candidate: any = input;
    if (typeof candidate.toDate === 'function') {
      try {
        return candidate.toDate().getTime();
      } catch {
        return null;
      }
    }
    const seconds = typeof candidate.seconds === 'number'
      ? candidate.seconds
      : typeof candidate._seconds === 'number'
        ? candidate._seconds
        : null;
    if (seconds !== null) {
      const nanos = typeof candidate.nanoseconds === 'number'
        ? candidate.nanoseconds
        : typeof candidate._nanoseconds === 'number'
          ? candidate._nanoseconds
          : 0;
      return seconds * 1000 + Math.floor(nanos / 1e6);
    }
  }
  return null;
}

function evaluateDeliveryWindow(
  now: Date,
  timezone: string,
  deviceData: admin.firestore.DocumentData,
  requested: DailyQuoteTimeOfDay | 'auto'
): { shouldSend: true; timeOfDay: DailyQuoteTimeOfDay; dateKey: string } | null {
  if (requested === 'immediate') {
    const local = resolveLocalTime(now, timezone);
    return { shouldSend: true, timeOfDay: 'immediate', dateKey: local.dateKey };
  }

  const local = resolveLocalTime(now, timezone);
  const localSeconds = local.hour * 60 * 60 + local.minute * 60 + local.second;

  const windows: { key: DailyQuoteTimeOfDay; hour: number; minute: number; lastKeyField: string }[] = [
    { key: 'morning', hour: MORNING_HOUR, minute: MORNING_MINUTE, lastKeyField: 'lastDailyQuoteMorningDateKey' },
    { key: 'evening', hour: EVENING_HOUR, minute: EVENING_MINUTE, lastKeyField: 'lastDailyQuoteEveningDateKey' },
  ];

  const targets = requested === 'auto' ? windows : windows.filter(w => w.key === requested);

  for (const window of targets) {
    const lastKeyRaw = typeof deviceData[window.lastKeyField] === 'string' ? String(deviceData[window.lastKeyField]) : null;
    if (lastKeyRaw === local.dateKey) {
      continue;
    }

    const targetSeconds = window.hour * 60 * 60 + window.minute * 60;
    if (isWithinWindowSeconds(localSeconds, targetSeconds, WINDOW_MINUTES, WINDOW_EARLY_GRACE_SECONDS)) {
      return { shouldSend: true, timeOfDay: window.key, dateKey: local.dateKey };
    }
  }

  return null;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function resolveLocalTime(date: Date, timezone: string) {
  const parts = resolveLocalDateParts(date, timezone);
  const month = `${parts.month}`.padStart(2, '0');
  const day = `${parts.day}`.padStart(2, '0');
  return {
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
    dateKey: `${parts.year}-${month}-${day}`,
  };
}

function resolveLocalDateParts(date: Date, timezone: string): LocalDateParts {
  const tz = timezone || DEFAULT_TIMEZONE;
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = formatter.formatToParts(date);
    const map = parts.reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
    return {
      year: Number(map.year ?? date.getUTCFullYear()),
      month: Number(map.month ?? `${date.getUTCMonth() + 1}`.padStart(2, '0')),
      day: Number(map.day ?? `${date.getUTCDate()}`.padStart(2, '0')),
      hour: Number(map.hour ?? date.getUTCHours()),
      minute: Number(map.minute ?? date.getUTCMinutes()),
      second: Number(map.second ?? date.getUTCSeconds()),
    };
  } catch {
    if (tz !== DEFAULT_TIMEZONE) {
      return resolveLocalDateParts(date, DEFAULT_TIMEZONE);
    }
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      second: date.getUTCSeconds(),
    };
  }
}

function getTimezoneOffsetMsFor(date: Date, timezone: string): number {
  const parts = resolveLocalDateParts(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  return asUtc - date.getTime();
}

function convertLocalDateToUtcMs(local: LocalDateParts, timezone: string): number {
  const guessUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, 0);
  let offset = getTimezoneOffsetMsFor(new Date(guessUtc), timezone);
  let corrected = guessUtc - offset;

  for (let i = 0; i < 2; i += 1) {
    const newOffset = getTimezoneOffsetMsFor(new Date(corrected), timezone);
    if (newOffset === offset) {
      break;
    }
    offset = newOffset;
    corrected = guessUtc - offset;
  }

  return corrected;
}

function isWithinWindowSeconds(
  localSeconds: number,
  targetSeconds: number,
  windowMinutes: number,
  earlyGraceSeconds: number
): boolean {
  const diffSeconds = localSeconds - targetSeconds;
  return diffSeconds >= -earlyGraceSeconds && diffSeconds < windowMinutes * 60;
}

// Exposed only for unit tests.
export function __testEvaluateDeliveryWindow(
  now: Date,
  timezone: string,
  deviceData: admin.firestore.DocumentData,
  requested: DailyQuoteTimeOfDay | 'auto'
): { shouldSend: true; timeOfDay: DailyQuoteTimeOfDay; dateKey: string } | null {
  return evaluateDeliveryWindow(now, timezone, deviceData, requested);
}

async function selectQuote(): Promise<Quote> {
  const apiQuote = await fetchRemoteQuote();
  if (apiQuote) {
    return apiQuote;
  }
  return pickLocalQuote();
}

function pickLocalQuote(): Quote {
  if (DAILY_QUOTES_LIBRARY.length === 0) {
    return {
      text: 'Learning never stops, and neither should your curiosity.',
      author: 'Tuition Manager',
      category: 'inspirational',
      source: 'local',
    };
  }
  const index = Math.floor(Math.random() * DAILY_QUOTES_LIBRARY.length);
  const base = DAILY_QUOTES_LIBRARY[index];
  return { ...base };
}

async function fetchRemoteQuote(): Promise<Quote | null> {
  const apis: {
    name: Quote['source'];
    url: string;
    parser: (data: any) => Quote | null;
  }[] = [
    {
      name: 'quotable',
      url: 'https://api.quotable.io/random',
      parser: (data: any) => {
        if (!data?.content || !data?.author) return null;
        return {
          text: String(data.content),
          author: String(data.author),
          category: mapQuotableCategory(Array.isArray(data.tags) && data.tags.length ? data.tags[0] : 'inspirational'),
          source: 'quotable',
          id: typeof data._id === 'string' ? data._id : undefined,
        };
      },
    },
    {
      name: 'zenquotes',
      url: 'https://zenquotes.io/api/random',
      parser: (data: any) => {
        if (!Array.isArray(data) || data.length === 0) return null;
        const item = data[0];
        if (!item?.q || !item?.a) return null;
        return {
          text: String(item.q),
          author: String(item.a),
          category: 'inspirational',
          source: 'zenquotes',
          id: typeof item.h === 'string' ? item.h : undefined,
        };
      },
    },
    {
      name: 'quotegarden',
      url: 'https://quotegarden.herokuapp.com/api/v3/quotes/random',
      parser: (data: any) => {
        if (!data?.data || !Array.isArray(data.data) || data.data.length === 0) return null;
        const item = data.data[0];
        const text = item?.quoteText;
        const author = item?.quoteAuthor;
        if (!text || !author) return null;
        return {
          text: String(text),
          author: String(author),
          category: 'inspirational',
          source: 'quotegarden',
          id: typeof item._id === 'string' ? item._id : undefined,
        };
      },
    },
  ];

  for (const api of apis) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      try {
        const response = await fetch(api.url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) {
          continue;
        }
        const data = await response.json();
        const quote = api.parser(data);
        if (quote) {
          return quote;
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      continue;
    }
  }

  return null;
}

function mapQuotableCategory(tag: string): string {
  const map: Record<string, string> = {
    motivational: 'motivational',
    inspirational: 'inspirational',
    wisdom: 'wisdom',
    success: 'success',
    life: 'life',
    leadership: 'leadership',
    education: 'educational',
    happiness: 'happiness',
    perseverance: 'perseverance',
    creativity: 'creativity',
    'famous-quotes': 'inspirational',
    philosophy: 'wisdom',
    science: 'educational',
    technology: 'creativity',
  };
  const key = typeof tag === 'string' ? tag.toLowerCase() : '';
  return map[key] || 'inspirational';
}

function composeQuoteBody(quote: Quote): string {
  if (quote.author) {
    return `"${quote.text}"\n- ${quote.author}`;
  }
  return quote.text;
}

function normalizeEmail(email: string | undefined | null): string {
  return (email || '').trim().toLowerCase();
}

function normalizeNumericEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}
