import admin from 'firebase-admin';
import crypto from 'crypto';
import { ensureFirebase, getFirestore } from '../firebaseAdmin';
import {
  ExpoPushMessage,
  PushTokenRecord,
  markPushTokensInvalid,
  sendExpoMessages,
} from '../pushUtils';
import { sendBillingEventEmails } from '../tenantNotificationEmail';

type FirestoreLike = ReturnType<typeof getFirestore>;

export type BillingEventKind =
  | 'subscription_activated'
  | 'subscription_charged'
  | 'subscription_pending'
  | 'payment_failed'
  | 'subscription_failed'
  | 'subscription_cancelled'
  | 'downgrade_to_free_scheduled'
  | 'downgrade_to_free_immediate'
  | 'plan_overridden';

export interface BillingEventNotification {
  tenantId: string;
  tenantName?: string;
  kind: BillingEventKind;
  title: string;
  body: string;
  priority?: 'low' | 'medium' | 'high';
  actionUrl?: string;
  metadata?: Record<string, unknown>;
  // Optional idempotency key for notice creation; prevents duplicate notices when multiple sources emit the same event.
  dedupeKey?: string;
  // Defaults to true. Use false to send push-only without creating a notice.
  createNotice?: boolean;
  // Defaults to true. Use false for operator/admin overrides to avoid emailing users.
  sendEmail?: boolean;
}

export interface BillingEventNotificationResult {
  ok: boolean;
  noticeId?: string;
  pushSent: number;
  pushFailed: number;
  pushRecipients: number;
  emailRecipients: number;
  emailSummary?: {
    attempted: number;
    sent: number;
    failed: number;
    skipped: number;
    disabled?: boolean;
  };
}

interface CachedDeviceRecord {
  token: string;
  deviceDocPath: string;
  deviceId?: string;
  ownerEmail: string;
  notificationsEnabled?: boolean;
  noticeNotificationsEnabled?: boolean;
  isDeleted?: boolean;
}

function coerceTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeActorRoleLabel(role: string | null): string | null {
  if (!role) return null;
  const normalized = role.trim().toLowerCase();
  if (!normalized) return null;
  // Keep user-facing roles simple.
  if (normalized === 'master') return 'admin';
  return role;
}

function appendBillingAttribution(body: string, metadata?: Record<string, unknown>): string {
  if (!metadata) return body;

  const lines: string[] = [];

  const source = coerceTrimmedString((metadata as any).source);

  const payerEmail = coerceTrimmedString((metadata as any).payerEmail);
  const createdByEmail = coerceTrimmedString((metadata as any).createdByEmail);
  const createdByRole = normalizeActorRoleLabel(coerceTrimmedString((metadata as any).createdByRole));

  const actorEmail = coerceTrimmedString((metadata as any).actorEmail);
  const actorId = coerceTrimmedString((metadata as any).actorId);
  const actorRole = normalizeActorRoleLabel(coerceTrimmedString((metadata as any).actorRole));

  if (payerEmail) lines.push(`Payer: ${payerEmail}`);

  const madeByEmail = actorEmail || createdByEmail;
  const madeByRole = actorEmail ? actorRole : createdByRole;

  if (madeByEmail) {
    const suffix = madeByRole ? ` (${madeByRole})` : '';
    lines.push(`Made by: ${madeByEmail}${suffix}`);
  } else if (source === 'admin_console' && actorRole) {
    // Master/admin-console actions often have no resolvable email.
    lines.push('Made by: organization');
  } else if (actorRole) {
    lines.push(`Made by: ${actorRole}`);
  } else if (actorId) {
    // Fall back to a generic label; avoid exposing raw internal ids.
    lines.push('Made by: System');
  }

  if (!lines.length) return body;
  return `${body}\n${lines.join('\n')}`;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function formatIsoIstForDisplay(iso: string | undefined | null): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  try {
    const formatter = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const parts = formatter.formatToParts(date);
    const map = new Map(parts.map((p) => [p.type, p.value] as const));
    const dd = map.get('day');
    const mon = map.get('month');
    const yyyy = map.get('year');
    const hour = map.get('hour');
    const minute = map.get('minute');
    const dayPeriod = map.get('dayPeriod');
    if (dd && mon && yyyy && hour && minute && dayPeriod) {
      return `${dd} ${mon} ${yyyy}, ${hour}:${minute} ${dayPeriod} IST`;
    }
  } catch {
    // fall through
  }

  // Fallback: manual IST conversion (UTC+05:30)
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  const mon = months[ist.getUTCMonth()] ?? '';
  const yyyy = ist.getUTCFullYear();
  let hour24 = ist.getUTCHours();
  const minute = String(ist.getUTCMinutes()).padStart(2, '0');
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  hour24 = hour24 % 12;
  const hour12 = hour24 === 0 ? 12 : hour24;
  return `${dd} ${mon} ${yyyy}, ${hour12}:${minute} ${ampm} IST`;
}

function formatIsoTimestampsInBody(body: string): string {
  if (typeof body !== 'string' || !body) return body;
  const isoRegex = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})\b/g;
  return body.replace(isoRegex, (match) => formatIsoIstForDisplay(match) || match);
}

function getActiveFirestore(): FirestoreLike {
  ensureFirebase();
  return getFirestore();
}

async function loadTenantMeta(db: FirestoreLike, tenantId: string): Promise<{ name?: string; ownerEmail?: string }>{
  const snap = await db.collection('tenants').doc(tenantId).get();
  const data = snap.exists ? snap.data() ?? {} : {};
  return {
    name: typeof data.name === 'string' ? data.name : undefined,
    ownerEmail: typeof data.ownerEmail === 'string' ? normalizeEmail(data.ownerEmail) : undefined,
  };
}

async function getTenantAdminAndOwnerEmails(db: FirestoreLike, tenantId: string): Promise<string[]> {
  const snapshot = await db
    .collection('tenantMemberships')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'active')
    .where('role', 'in', ['owner', 'admin'])
    .get();
  return snapshot.docs
    .map((doc) => doc.get('email'))
    .filter((email): email is string => typeof email === 'string' && email.trim().length > 0)
    .map(normalizeEmail);
}

async function getTenantOwnerEmails(db: FirestoreLike, tenantId: string): Promise<string[]> {
  const snapshot = await db
    .collection('tenantMemberships')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'active')
    .where('role', '==', 'owner')
    .get();
  return snapshot.docs
    .map((doc) => doc.get('email'))
    .filter((email): email is string => typeof email === 'string' && email.trim().length > 0)
    .map(normalizeEmail);
}

async function getDevicesForUser(db: FirestoreLike, email: string): Promise<CachedDeviceRecord[]> {
  const normalized = normalizeEmail(email);
  const devicesSnap = await db
    .collection('user_devices')
    .doc(normalized)
    .collection('devices')
    .select(
      'expoPushToken',
      'notificationsEnabled',
      'noticeNotificationsEnabled',
      'isDeleted',
      'deviceId'
    )
    .get();

  return devicesSnap.docs
    .map((doc) => {
      const data = doc.data();
      const token = typeof data?.expoPushToken === 'string' ? data.expoPushToken.trim() : '';
      return {
        token,
        deviceDocPath: doc.ref.path,
        deviceId: data?.deviceId,
        ownerEmail: normalized,
        notificationsEnabled: data?.notificationsEnabled,
        noticeNotificationsEnabled: data?.noticeNotificationsEnabled,
        isDeleted: data?.isDeleted,
      };
    })
    .filter((record) => Boolean(record.token));
}

function shouldDeliverToDevice(device: CachedDeviceRecord): boolean {
  if (!device.token) return false;
  if (device.isDeleted) return false;
  if (device.notificationsEnabled === false) return false;
  if (device.noticeNotificationsEnabled === false) return false;
  return true;
}

async function collectDeliverableDevices(db: FirestoreLike, recipients: string[]): Promise<Map<string, CachedDeviceRecord>> {
  const tokenToDevice = new Map<string, CachedDeviceRecord>();
  const blockedTokens = new Set<string>();

  for (const recipient of recipients) {
    const devices = await getDevicesForUser(db, recipient);
    for (const device of devices) {
      if (!shouldDeliverToDevice(device)) {
        if (device.token && device.noticeNotificationsEnabled === false) {
          blockedTokens.add(device.token);
          tokenToDevice.delete(device.token);
        }
        continue;
      }
      if (device.token && !blockedTokens.has(device.token) && !tokenToDevice.has(device.token)) {
        tokenToDevice.set(device.token, device);
      }
    }
  }

  for (const token of blockedTokens) {
    tokenToDevice.delete(token);
  }

  return tokenToDevice;
}

async function createBillingNotice(db: FirestoreLike, params: {
  tenantId: string;
  title: string;
  content: string;
  priority: 'low' | 'medium' | 'high';
  targetTenantRoles: Array<'owner' | 'admin'>;
  dedupeKey?: string;
}): Promise<string> {
  const notices = db.collection('notices');

  if (!params.dedupeKey) {
    const ref = await notices.add({
      tenantId: params.tenantId,
      title: params.title,
      content: params.content,
      priority: params.priority,
      targetAudience: ['all'],
      targetTenantRoles: params.targetTenantRoles,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: 'system',
      createdByRole: 'system',
      createdByName: 'Billing',
      createdByEmail: 'billing@system',
      isActive: true,
      viewCount: 0,
      userViews: {},
    });
    return ref.id;
  }

  const hash = crypto
    .createHash('sha256')
    .update(`${params.tenantId}|${params.dedupeKey}`)
    .digest('hex')
    .slice(0, 32);
  const docId = `billing_${hash}`;
  const ref = notices.doc(docId);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      tx.set(
        ref,
        {
          title: params.title,
          content: params.content,
          priority: params.priority,
          targetAudience: ['all'],
          targetTenantRoles: params.targetTenantRoles,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          isActive: true,
        },
        { merge: true }
      );
      return;
    }

    tx.set(ref, {
      tenantId: params.tenantId,
      title: params.title,
      content: params.content,
      priority: params.priority,
      targetAudience: ['all'],
      targetTenantRoles: params.targetTenantRoles,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: 'system',
      createdByRole: 'system',
      createdByName: 'Billing',
      createdByEmail: 'billing@system',
      isActive: true,
      viewCount: 0,
      userViews: {},
    });
  });

  return ref.id;
}

export async function sendTenantBillingEventNotification(
  event: BillingEventNotification
): Promise<BillingEventNotificationResult> {
  const db = getActiveFirestore();
  const tenantId = event.tenantId.trim();
  if (!tenantId) {
    return {
      ok: true,
      pushSent: 0,
      pushFailed: 0,
      pushRecipients: 0,
      emailRecipients: 0,
    };
  }

  const shouldSendEmail = event.sendEmail !== false;
  const shouldCreateNotice = event.createNotice !== false;

  const meta = await loadTenantMeta(db, tenantId);
  const tenantName = (event.tenantName || meta.name || '').trim() || undefined;

  const [pushRecipients, ownerRecipients] = await Promise.all([
    getTenantAdminAndOwnerEmails(db, tenantId),
    getTenantOwnerEmails(db, tenantId),
  ]);

  const normalizedPushRecipients = Array.from(new Set(pushRecipients.map(normalizeEmail)));
  const normalizedOwnerRecipients = Array.from(new Set(ownerRecipients.map(normalizeEmail)));

  if (!normalizedOwnerRecipients.length && meta.ownerEmail) {
    normalizedOwnerRecipients.push(meta.ownerEmail);
  }

  const normalizedEmailRecipients = [...normalizedOwnerRecipients];
  if (shouldSendEmail && event.metadata) {
    const createdByEmail = coerceTrimmedString((event.metadata as any).createdByEmail);
    const createdByRoleRaw = coerceTrimmedString((event.metadata as any).createdByRole);
    const createdByRole = createdByRoleRaw ? createdByRoleRaw.trim().toLowerCase() : null;

    const isPaymentRelatedEvent =
      event.kind === 'subscription_activated' ||
      event.kind === 'subscription_charged' ||
      event.kind === 'subscription_pending' ||
      event.kind === 'payment_failed' ||
      event.kind === 'subscription_failed';

    // Only add the initiating admin; if initiated by owner, do not email any admins.
    if (isPaymentRelatedEvent && createdByEmail && createdByRole === 'admin') {
      const normalizedCreatedBy = normalizeEmail(createdByEmail);
      if (!normalizedEmailRecipients.includes(normalizedCreatedBy)) {
        normalizedEmailRecipients.push(normalizedCreatedBy);
      }
    }
  }

  const priority =
    event.priority ||
    (event.kind === 'subscription_pending' || event.kind === 'payment_failed' || event.kind === 'subscription_failed'
      ? 'high'
      : 'medium');

  const bodyWithAttribution = appendBillingAttribution(formatIsoTimestampsInBody(event.body), event.metadata);

  let noticeId: string | undefined;
  if (shouldCreateNotice) {
    try {
      noticeId = await createBillingNotice(db, {
        tenantId,
        title: event.title,
        content: bodyWithAttribution,
        priority,
        targetTenantRoles: ['owner', 'admin'],
        dedupeKey: event.dedupeKey,
      });
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[billing_notifier] failed to create notice', error);
      }
    }
  }

  let pushSent = 0;
  let pushFailed = 0;

  if (normalizedPushRecipients.length) {
    try {
      const tokenToDevice = await collectDeliverableDevices(db, normalizedPushRecipients);
      if (tokenToDevice.size) {
        const timestamp = new Date().toISOString();
        const messages: ExpoPushMessage[] = [];
        const expoPriority = priority === 'high' ? 'high' : 'default';

        for (const device of tokenToDevice.values()) {
          messages.push({
            to: device.token,
            title: event.title,
            body: bodyWithAttribution,
            sound: 'default',
            priority: expoPriority,
            data: {
              type: 'notice_created',
              noticeId: noticeId ?? null,
              tenantId,
              tenantName: tenantName ?? null,
              eventType: 'billing_event',
              billingEventKind: event.kind,
              ...(event.metadata ? { metadata: event.metadata } : {}),
              timestamp,
            },
          });
        }

        const result = await sendExpoMessages(messages, { context: 'billing_event' });
        pushSent = result.sent;
        pushFailed = result.failed;

        if (result.invalidTokens.length) {
          const invalidRecords: PushTokenRecord[] = [];
          for (const token of result.invalidTokens) {
            const device = tokenToDevice.get(token);
            if (device) {
              invalidRecords.push({
                token,
                deviceDocPath: device.deviceDocPath,
                deviceId: device.deviceId,
                ownerEmail: device.ownerEmail,
              });
            }
          }
          if (invalidRecords.length) {
            await markPushTokensInvalid(invalidRecords, { context: 'billing_event' });
          }
        }
      }
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[billing_notifier] push send failed', error);
      }
    }
  }

  let emailSummary: BillingEventNotificationResult['emailSummary'] | undefined;
  if (shouldSendEmail && normalizedEmailRecipients.length) {
    try {
      const res = await sendBillingEventEmails(
        {
          tenantId,
          tenantName,
          summaryTitle: event.title,
          summaryBody: bodyWithAttribution,
          ...(event.actionUrl ? { actionUrl: event.actionUrl } : {}),
          subject: tenantName ? `Billing update • ${tenantName}` : 'Billing update',
        },
        normalizedEmailRecipients
      );
      emailSummary = res;
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[billing_notifier] email send failed', error);
      }
    }
  }

  return {
    ok: pushFailed === 0,
    noticeId,
    pushSent,
    pushFailed,
    pushRecipients: normalizedPushRecipients.length,
    emailRecipients: normalizedEmailRecipients.length,
    emailSummary,
  };
}
