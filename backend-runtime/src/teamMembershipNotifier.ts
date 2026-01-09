import { ensureFirebase, getFirestore } from './firebaseAdmin';
import {
  ExpoPushMessage,
  PushTokenRecord,
  markPushTokensInvalid,
  sendExpoMessages,
} from './pushUtils';
import {
  JoinRequestEmailResult,
  sendTeamMembershipChangeEmails,
  sendTenantJoinRequestEmails,
} from './tenantNotificationEmail';

type FirestoreLike = ReturnType<typeof getFirestore>;

export type TeamMembershipChangeAction = 'added' | 'removed' | 'role_changed';
type TenantNotifierRole = 'owner' | 'admin' | 'staff' | 'member' | 'user';

export interface TeamMembershipEvent {
  tenantId?: string;
  tenantName?: string;
  action: TeamMembershipChangeAction;
  targetEmail: string;
  targetRole?: TenantNotifierRole;
  previousRole?: TenantNotifierRole;
  actorEmail?: string | null;
  metadata?: {
    displayName?: string;
    reason?: string;
    initiatedFrom?: 'web' | 'mobile' | 'system';
    actorName?: string;
  };
}

export interface TenantJoinRequestEvent {
  tenantId: string;
  tenantName?: string;
  requestId: string;
  requesterEmail: string;
  requesterName?: string;
  message?: string;
}

export interface TenantJoinRequestOutcomeEvent {
  tenantId: string;
  tenantName?: string;
  requestId: string;
  requesterEmail: string;
  requesterName?: string;
  reviewerEmail?: string;
  reviewerName?: string;
  outcome: 'approved' | 'rejected';
  assignedRole?: TenantNotifierRole;
}

export interface TeamMembershipNotificationResult {
  ok: boolean;
  sent: number;
  failed: number;
  recipients: number;
  emailSummary?: JoinRequestEmailResult;
}

interface CachedDeviceRecord {
  token: string;
  deviceDocPath: string;
  deviceId?: string;
  ownerEmail: string;
  notificationsEnabled?: boolean;
  teamNotificationsEnabled?: boolean;
  isDeleted?: boolean;
}

let firestoreOverride: FirestoreLike | null = null;
let sendExpoMessagesImpl = sendExpoMessages;
let markPushTokensInvalidImpl = markPushTokensInvalid;
let sendTenantJoinRequestEmailsImpl = sendTenantJoinRequestEmails;
let sendTeamMembershipChangeEmailsImpl = sendTeamMembershipChangeEmails;

const ADMIN_CACHE_TTL_MS = 30_000;
const DEVICE_CACHE_TTL_MS = 60_000;
const TENANT_CACHE_TTL_MS = 30_000;

const legacyAdminCache: { emails: Set<string>; fetchedAt: number } = {
  emails: new Set(),
  fetchedAt: 0,
};
const deviceCache = new Map<string, { fetchedAt: number; devices: CachedDeviceRecord[] }>();
const tenantAdminCache = new Map<string, { emails: Set<string>; fetchedAt: number }>();
const tenantMetadataCache = new Map<string, { fetchedAt: number; data: TenantMetadataCacheEntry }>();

interface TenantMetadataCacheEntry {
  name?: string;
  membershipEventsPush: boolean;
  membershipEventsEmail: boolean;
  joinRequestPush: boolean;
  joinRequestEmail: boolean;
}

function getActiveFirestore(): FirestoreLike {
  if (firestoreOverride) {
    return firestoreOverride;
  }
  ensureFirebase();
  return getFirestore();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function getLegacyTenantAdminEmails(tenantId = 'legacy-coaching'): Promise<string[]> {
  const now = Date.now();
  if (legacyAdminCache.emails.size && now - legacyAdminCache.fetchedAt < ADMIN_CACHE_TTL_MS) {
    return Array.from(legacyAdminCache.emails);
  }
  const db = getActiveFirestore();
  const snapshot = await db
    .collection('tenantMemberships')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'active')
    .where('role', 'in', ['owner', 'admin'])
    .get();
  const emails = snapshot.docs
    .map((doc) => doc.get('email'))
    .filter((email): email is string => typeof email === 'string' && email.trim().length > 0)
    .map(normalizeEmail);
  legacyAdminCache.emails = new Set(emails);
  legacyAdminCache.fetchedAt = now;
  return emails;
}

async function getTenantMetadata(tenantId: string): Promise<TenantMetadataCacheEntry> {
  const cached = tenantMetadataCache.get(tenantId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TENANT_CACHE_TTL_MS) {
    return cached.data;
  }

  const db = getActiveFirestore();
  const snap = await db.collection('tenants').doc(tenantId).get();
  const data = snap.exists ? snap.data() ?? {} : {};
  const prefs = (data.notificationPreferences as Record<string, any> | undefined) || {};

  const entry: TenantMetadataCacheEntry = {
    name: typeof data.name === 'string' ? data.name : undefined,
    membershipEventsPush: prefs.membershipEventsPush !== false,
    membershipEventsEmail: prefs.membershipEventsEmail !== false,
    joinRequestPush: prefs.joinRequestPush !== false,
    joinRequestEmail: prefs.joinRequestEmail !== false,
  };
  tenantMetadataCache.set(tenantId, { fetchedAt: now, data: entry });
  return entry;
}

async function getTenantAdminEmails(tenantId: string): Promise<string[]> {
  const cached = tenantAdminCache.get(tenantId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < TENANT_CACHE_TTL_MS) {
    return Array.from(cached.emails);
  }

  const db = getActiveFirestore();
  const snapshot = await db
    .collection('tenantMemberships')
    .where('tenantId', '==', tenantId)
    .where('status', '==', 'active')
    .get();

  const allowedRoles = new Set(['owner', 'admin']);
  const emails = new Set<string>();
  snapshot.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const role = typeof data.role === 'string' ? data.role.toLowerCase() : '';
    if (!allowedRoles.has(role)) {
      return;
    }
    const email = typeof data.email === 'string' ? data.email : '';
    if (!email.trim()) {
      return;
    }
    emails.add(normalizeEmail(email));
  });

  tenantAdminCache.set(tenantId, { fetchedAt: now, emails });
  return Array.from(emails);
}

async function getDevicesForUser(email: string): Promise<CachedDeviceRecord[]> {
  const normalized = normalizeEmail(email);
  const cached = deviceCache.get(normalized);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < DEVICE_CACHE_TTL_MS) {
    return cached.devices;
  }

  const db = getActiveFirestore();
  const devicesSnap = await db
    .collection('user_devices')
    .doc(normalized)
    .collection('devices')
    .select(
      'expoPushToken',
      'notificationsEnabled',
      'teamNotificationsEnabled',
      'isDeleted',
      'deviceId'
    )
    .get();

  const devices: CachedDeviceRecord[] = devicesSnap.docs
    .map((doc) => {
      const data = doc.data();
      const token = typeof data?.expoPushToken === 'string' ? data.expoPushToken.trim() : '';
      return {
        token,
        deviceDocPath: doc.ref.path,
        deviceId: data?.deviceId,
        ownerEmail: normalized,
        notificationsEnabled: data?.notificationsEnabled,
        teamNotificationsEnabled: data?.teamNotificationsEnabled,
        isDeleted: data?.isDeleted,
      };
    })
    .filter(record => Boolean(record.token));

  deviceCache.set(normalized, { fetchedAt: now, devices });
  return devices;
}

function shouldDeliverToDevice(device: CachedDeviceRecord): boolean {
  if (!device.token) return false;
  if (device.isDeleted) return false;
  if (device.notificationsEnabled === false) return false;
  if (device.teamNotificationsEnabled === false) return false;
  return true;
}

async function collectDeliverableDevices(recipients: string[]): Promise<Map<string, CachedDeviceRecord>> {
  const tokenToDevice = new Map<string, CachedDeviceRecord>();
  const blockedTokens = new Set<string>();

  for (const recipient of recipients) {
    const devices = await getDevicesForUser(recipient);
    for (const device of devices) {
      if (!shouldDeliverToDevice(device)) {
        if (device.token && device.teamNotificationsEnabled === false) {
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

function resolveRoleLabel(role?: TenantNotifierRole): { label: string; tier: 'admin' | 'member' } {
  const normalized = (role || '').toLowerCase() as TenantNotifierRole;
  switch (normalized) {
    case 'owner':
      return { label: 'owner', tier: 'admin' };
    case 'admin':
      return { label: 'admin', tier: 'admin' };
    case 'staff':
      return { label: 'staff member', tier: 'member' };
    default:
      return { label: 'member', tier: 'member' };
  }
}

export function buildTeamMembershipCopy(event: TeamMembershipEvent): { title: string; body: string } {
  const displayName = event.metadata?.displayName || event.targetEmail;
  const actorIdentity = event.metadata?.actorName || event.actorEmail;
  const actorSegment = actorIdentity ? ` by ${actorIdentity}` : '';
  const tenantSegment = event.tenantName ? ` in ${event.tenantName}` : '';

  switch (event.action) {
    case 'added': {
      const { label, tier } = resolveRoleLabel(event.targetRole);
      return {
        title: tier === 'admin' ? `New ${label} added` : 'New member onboarded',
        body: `${displayName} was added as ${label}${tenantSegment}${actorSegment}.`,
      };
    }
    case 'removed': {
      const { label, tier } = resolveRoleLabel(event.targetRole);
      return {
        title: tier === 'admin' ? `${label.charAt(0).toUpperCase() + label.slice(1)} removed` : 'Member removed',
        body: `${displayName} was removed from${tenantSegment || ' the team'}${actorSegment}.`,
      };
    }
    case 'role_changed': {
      if (event.previousRole && event.targetRole && event.previousRole !== event.targetRole) {
        const prevTier = resolveRoleLabel(event.previousRole).tier;
        const nextTier = resolveRoleLabel(event.targetRole).tier;
        const promoted = prevTier === 'member' && nextTier === 'admin';
        if (promoted) {
          return {
            title: 'Member promoted to admin',
            body: `${displayName} is now part of the admin team${tenantSegment}${actorSegment}.`,
          };
        }
        if (prevTier === 'admin' && nextTier === 'member') {
          return {
            title: 'Admin role updated',
            body: `${displayName} now has member access${tenantSegment}${actorSegment}.`,
          };
        }
      }
      return {
        title: 'Team role updated',
        body: `${displayName}'s role changed${tenantSegment}${actorSegment}.`,
      };
    }
    default:
      return {
        title: 'Team update',
        body: `${displayName} had their membership updated${tenantSegment}${actorSegment}.`,
      };
  }
}

function buildTenantJoinRequestCopy(event: TenantJoinRequestEvent): { title: string; body: string } {
  const applicant = event.requesterName || event.requesterEmail;
  const tenantSegment = event.tenantName ? ` for ${event.tenantName}` : '';
  const trimmedMessage = event.message?.trim();
  const messageSnippet = trimmedMessage
    ? ` Message: "${trimmedMessage.slice(0, 100)}${trimmedMessage.length > 100 ? '…' : ''}"`
    : '';

  return {
    title: event.tenantName ? `New join request • ${event.tenantName}` : 'New join request',
    body: `${applicant} requested access${tenantSegment}.${messageSnippet}`,
  };
}

function buildTenantJoinRequestOutcomeCopy(event: TenantJoinRequestOutcomeEvent): { title: string; body: string } {
  const tenantSegment = event.tenantName ? ` for ${event.tenantName}` : '';
  const reviewerSegment = event.reviewerName || event.reviewerEmail;

  if (event.outcome === 'approved') {
    const assignment = event.assignedRole ? resolveRoleLabel(event.assignedRole).label : null;
    const roleSegment = assignment ? ` as ${assignment}` : '';
    const reviewerCopy = reviewerSegment ? ` ${reviewerSegment} approved your access.` : '';
    return {
      title: 'Join request approved',
      body: `You're now part of this coaching center${tenantSegment}${roleSegment}.${reviewerCopy}`.trim(),
    };
  }

  const reviewerCopy = reviewerSegment ? ` by ${reviewerSegment}` : '';
  return {
    title: 'Join request rejected',
    body: `Your join request${tenantSegment} was declined${reviewerCopy}.`,
  };
}

export async function sendTeamMembershipChangeNotification(
  event: TeamMembershipEvent
): Promise<TeamMembershipNotificationResult> {
  const normalizedEvent: TeamMembershipEvent = {
    ...event,
    targetEmail: normalizeEmail(event.targetEmail),
    actorEmail: event.actorEmail ? normalizeEmail(event.actorEmail) : event.actorEmail,
    tenantId: event.tenantId?.trim() || undefined,
    tenantName: event.tenantName?.trim() || event.tenantName,
  };
  let adminRecipients: string[] = [];
  let shouldSendPush = true;
  let shouldSendEmail = false;

  if (normalizedEvent.tenantId) {
    const [tenantMeta, tenantScopedRecipients] = await Promise.all([
      getTenantMetadata(normalizedEvent.tenantId),
      getTenantAdminEmails(normalizedEvent.tenantId),
    ]);

    if (!normalizedEvent.tenantName && tenantMeta.name) {
      normalizedEvent.tenantName = tenantMeta.name;
    }

    adminRecipients = tenantScopedRecipients.filter(
      (email) => email && email !== normalizedEvent.targetEmail
    );

    shouldSendPush = tenantMeta.membershipEventsPush !== false;
    shouldSendEmail = tenantMeta.membershipEventsEmail !== false;
  } else {
    adminRecipients = (await getLegacyTenantAdminEmails()).filter(
      (email) => email && email !== normalizedEvent.targetEmail
    );
    shouldSendPush = true;
    shouldSendEmail = false;
  }

  if (!adminRecipients.length) {
    return { ok: true, sent: 0, failed: 0, recipients: 0 };
  }

  const { title, body } = buildTeamMembershipCopy(normalizedEvent);

  const emailPromise = shouldSendEmail && normalizedEvent.tenantId
    ? sendTeamMembershipChangeEmailsImpl(
        {
          tenantId: normalizedEvent.tenantId,
          tenantName: normalizedEvent.tenantName,
          action: normalizedEvent.action,
          targetEmail: normalizedEvent.targetEmail,
          targetRole: normalizedEvent.targetRole,
          previousRole: normalizedEvent.previousRole,
          actorEmail: normalizedEvent.actorEmail ?? undefined,
          actorName: normalizedEvent.metadata?.actorName,
          displayName: normalizedEvent.metadata?.displayName,
          reason: normalizedEvent.metadata?.reason,
          initiatedFrom: normalizedEvent.metadata?.initiatedFrom,
          summaryTitle: title,
          summaryBody: body,
        },
        adminRecipients,
      ).catch((error) => {
        if (process.env.NODE_ENV !== 'test') {
          console.warn('[team_membership] email send failed', error);
        }
        return undefined;
      })
    : undefined;

  let pushSent = 0;
  let pushFailed = 0;

  if (shouldSendPush) {
    const tokenToDevice = await collectDeliverableDevices(adminRecipients);

    if (tokenToDevice.size) {
      const timestamp = new Date().toISOString();
      const messages: ExpoPushMessage[] = [];
      for (const device of tokenToDevice.values()) {
        messages.push({
          to: device.token,
          title,
          body,
          sound: 'default',
          priority: 'high',
          data: {
            type: 'team_membership_change',
            action: normalizedEvent.action,
            targetEmail: normalizedEvent.targetEmail,
            targetRole: normalizedEvent.targetRole ?? null,
            previousRole: normalizedEvent.previousRole ?? null,
            actorEmail: normalizedEvent.actorEmail ?? null,
            tenantId: normalizedEvent.tenantId ?? null,
            tenantName: normalizedEvent.tenantName ?? null,
            metadata: normalizedEvent.metadata ?? {},
            timestamp,
          },
        });
      }

      const result = await sendExpoMessagesImpl(messages, { context: 'team_membership' });
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
            deviceCache.delete(device.ownerEmail);
          }
        }
        if (invalidRecords.length) {
          await markPushTokensInvalidImpl(invalidRecords, { context: 'team_membership' });
        }
      }
    }
  }

  const emailSummary = emailPromise ? await emailPromise : undefined;

  return {
    ok: pushFailed === 0,
    sent: pushSent,
    failed: pushFailed,
    recipients: adminRecipients.length,
    emailSummary,
  };
}

export async function sendTenantJoinRequestNotification(
  event: TenantJoinRequestEvent
): Promise<TeamMembershipNotificationResult> {
  const normalizedEvent: TenantJoinRequestEvent = {
    ...event,
    tenantName: event.tenantName?.trim() || event.tenantName,
    requesterEmail: normalizeEmail(event.requesterEmail),
  };

  const tenantMeta = await getTenantMetadata(normalizedEvent.tenantId);
  if (!normalizedEvent.tenantName && tenantMeta.name) {
    normalizedEvent.tenantName = tenantMeta.name;
  }
  const shouldSendPush = tenantMeta.joinRequestPush !== false;
  const shouldSendEmail = tenantMeta.joinRequestEmail !== false;

  const adminRecipients = (await getTenantAdminEmails(normalizedEvent.tenantId)).filter(
    (email) => email && email !== normalizedEvent.requesterEmail
  );

  if (!adminRecipients.length) {
    return { ok: true, sent: 0, failed: 0, recipients: 0 };
  }

  const emailPromise =
    shouldSendEmail && adminRecipients.length
      ? sendTenantJoinRequestEmailsImpl(
          {
            tenantId: normalizedEvent.tenantId,
            tenantName: normalizedEvent.tenantName,
            requestId: normalizedEvent.requestId,
            requesterEmail: normalizedEvent.requesterEmail,
            requesterName: normalizedEvent.requesterName,
            message: normalizedEvent.message,
          },
          adminRecipients
        ).catch((error) => {
          if (process.env.NODE_ENV !== 'test') {
            console.warn('[tenant_join_request] email send failed', error);
          }
          return undefined;
        })
      : undefined;

  let pushSent = 0;
  let pushFailed = 0;

  if (shouldSendPush) {
    const tokenToDevice = await collectDeliverableDevices(adminRecipients);
    if (tokenToDevice.size) {
      const { title, body } = buildTenantJoinRequestCopy(normalizedEvent);
      const timestamp = new Date().toISOString();
      const messages: ExpoPushMessage[] = [];
      for (const device of tokenToDevice.values()) {
        messages.push({
          to: device.token,
          title,
          body,
          sound: 'default',
          priority: 'high',
          data: {
            type: 'tenant_join_request',
            requestId: normalizedEvent.requestId,
            tenantId: normalizedEvent.tenantId,
            tenantName: normalizedEvent.tenantName ?? null,
            requesterEmail: normalizedEvent.requesterEmail,
            requesterName: normalizedEvent.requesterName ?? null,
            message: normalizedEvent.message ?? null,
            timestamp,
          },
        });
      }

      const result = await sendExpoMessagesImpl(messages, { context: 'tenant_join_request' });
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
            deviceCache.delete(device.ownerEmail);
          }
        }
        if (invalidRecords.length) {
          await markPushTokensInvalidImpl(invalidRecords, { context: 'tenant_join_request' });
        }
      }
    }
  }

  const emailSummary = emailPromise ? await emailPromise : undefined;

  return {
    ok: pushFailed === 0,
    sent: pushSent,
    failed: pushFailed,
    recipients: adminRecipients.length,
    emailSummary,
  };
}

export async function sendTenantJoinRequestOutcomeNotification(
  event: TenantJoinRequestOutcomeEvent
): Promise<TeamMembershipNotificationResult> {
  const normalizedEvent: TenantJoinRequestOutcomeEvent = {
    ...event,
    tenantName: event.tenantName?.trim() || event.tenantName,
    requesterEmail: normalizeEmail(event.requesterEmail),
    reviewerEmail: event.reviewerEmail ? normalizeEmail(event.reviewerEmail) : event.reviewerEmail,
  };

  const tenantMeta = await getTenantMetadata(normalizedEvent.tenantId);
  if (!normalizedEvent.tenantName && tenantMeta.name) {
    normalizedEvent.tenantName = tenantMeta.name;
  }

  const recipients = normalizedEvent.requesterEmail ? [normalizedEvent.requesterEmail] : [];
  if (!recipients.length) {
    return { ok: true, sent: 0, failed: 0, recipients: 0 };
  }

  const shouldSendPush = tenantMeta.joinRequestPush !== false;
  if (!shouldSendPush) {
    return { ok: true, sent: 0, failed: 0, recipients: recipients.length };
  }

  const tokenToDevice = await collectDeliverableDevices(recipients);
  if (!tokenToDevice.size) {
    return { ok: true, sent: 0, failed: 0, recipients: recipients.length };
  }

  const { title, body } = buildTenantJoinRequestOutcomeCopy(normalizedEvent);
  const timestamp = new Date().toISOString();
  const messages: ExpoPushMessage[] = [];
  for (const device of tokenToDevice.values()) {
    messages.push({
      to: device.token,
      title,
      body,
      sound: 'default',
      priority: 'high',
      data: {
        type: 'tenant_join_request_outcome',
        requestId: normalizedEvent.requestId,
        tenantId: normalizedEvent.tenantId,
        tenantName: normalizedEvent.tenantName ?? null,
        outcome: normalizedEvent.outcome,
        assignedRole: normalizedEvent.assignedRole ?? null,
        reviewerEmail: normalizedEvent.reviewerEmail ?? null,
        reviewerName: normalizedEvent.reviewerName ?? null,
        timestamp,
      },
    });
  }

  const result = await sendExpoMessagesImpl(messages, { context: 'tenant_join_request_outcome' });

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
        deviceCache.delete(device.ownerEmail);
      }
    }
    if (invalidRecords.length) {
      await markPushTokensInvalidImpl(invalidRecords, { context: 'tenant_join_request_outcome' });
    }
  }

  return {
    ok: result.failed === 0,
    sent: result.sent,
    failed: result.failed,
    recipients: recipients.length,
  };
}

type TeamNotifierTestOverrides = {
  firestore?: FirestoreLike | null;
  sendExpo?: typeof sendExpoMessages | null;
  markInvalid?: typeof markPushTokensInvalid | null;
  sendJoinRequestEmail?: typeof sendTenantJoinRequestEmails | null;
  sendMembershipChangeEmail?: typeof sendTeamMembershipChangeEmails | null;
};

export function __setTeamMembershipNotifierTestOverrides(
  overrides: TeamNotifierTestOverrides = {}
): void {
  if ('firestore' in overrides) {
    firestoreOverride = overrides.firestore ?? null;
  }
  if ('sendExpo' in overrides) {
    sendExpoMessagesImpl = overrides.sendExpo ?? sendExpoMessages;
  }
  if ('markInvalid' in overrides) {
    markPushTokensInvalidImpl = overrides.markInvalid ?? markPushTokensInvalid;
  }
  if ('sendJoinRequestEmail' in overrides) {
    sendTenantJoinRequestEmailsImpl =
      overrides.sendJoinRequestEmail ?? sendTenantJoinRequestEmails;
  }
  if ('sendMembershipChangeEmail' in overrides) {
    sendTeamMembershipChangeEmailsImpl =
      overrides.sendMembershipChangeEmail ?? sendTeamMembershipChangeEmails;
  }
}

export function __resetTeamMembershipNotifierTestState(): void {
  firestoreOverride = null;
  sendExpoMessagesImpl = sendExpoMessages;
  markPushTokensInvalidImpl = markPushTokensInvalid;
  sendTenantJoinRequestEmailsImpl = sendTenantJoinRequestEmails;
  sendTeamMembershipChangeEmailsImpl = sendTeamMembershipChangeEmails;
  legacyAdminCache.emails.clear();
  legacyAdminCache.fetchedAt = 0;
  deviceCache.clear();
  tenantAdminCache.clear();
  tenantMetadataCache.clear();
}
