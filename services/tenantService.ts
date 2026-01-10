import { Platform } from 'react-native';
import { logger } from '@/lib/logger';
import { firestore } from '@/config/firebase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  addDoc,
  arrayUnion,
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';
import type {
  Tenant,
  TenantAuditLogEntry,
  TenantInvite,
  TenantJoinRequest,
  TenantMembership,
  TenantMembershipRole,
  TenantMembershipStatus,
  TenantMembershipStatusEvent,
  TenantQuota,
  TenantSettings,
  TenantTheme,
  TenantCode,
  TenantNotificationPreferences,
} from '@/types';
import { STORAGE_KEYS } from '@/lib/storageKeys';
import { teamMembershipNotifier } from './teamMembershipNotifier';
import { tenantBackendClient, TenantBackendError } from './tenantBackendClient';

type MembershipActionInitiatedFrom = 'web' | 'mobile' | 'system';

type BackendManagedMembershipStatus = Extract<
  TenantMembershipStatus,
  'active' | 'pending_request' | 'revoked' | 'rejected'
>;

interface MembershipAdminActionOptions {
  actorId?: string;
  actorEmail?: string;
  actorName?: string;
  actorRole?: TenantMembershipRole;
  reason?: string;
  initiatedFrom?: MembershipActionInitiatedFrom;
}

interface MembershipStatusEventContext {
  actorId?: string;
  actorEmail?: string;
  actorName?: string;
  reason?: string;
  at?: string;
}

function resolveMembershipActionInitiator(
  initiatedFrom?: MembershipActionInitiatedFrom,
): MembershipActionInitiatedFrom {
  if (initiatedFrom === 'web' || initiatedFrom === 'mobile' || initiatedFrom === 'system') {
    return initiatedFrom;
  }
  return Platform.OS === 'web' ? 'web' : 'mobile';
}

export interface CreateTenantInput {
  name: string;
  ownerUserId: string;
  ownerEmail: string;
  address?: string;
  timezone?: string;
  defaultCurrency?: string;
  contactEmail?: string;
  contactPhone?: string;
  logoUrl?: string;
  heroImageUrl?: string;
  theme?: TenantTheme;
}

export interface UpdateTenantInput extends Partial<Omit<Tenant, 'id'>> {
  id: string;
  updatedBy?: string;
}

export interface CreateJoinRequestInput {
  tenantId: string;
  userId: string;
  email: string;
  displayName?: string;
  message?: string;
  tenantName?: string;
}

const MEMBERSHIP_COLLECTION = 'tenantMemberships';
const TENANT_COLLECTION = 'tenants';
const JOIN_REQUEST_COLLECTION = 'tenantJoinRequests';
const INVITE_COLLECTION = 'tenantInvites';
const CODE_COLLECTION = 'tenantCodes';
const AUDIT_COLLECTION = 'tenantAuditLogs';
const MAX_ACTIVE_JOIN_CODES = 5;

const NO_QUOTA_OVERRIDES: TenantQuota = {
  maxStudents: null,
  maxStaff: null,
  maxMonthlyReminders: null,
  maxStorageMb: null,
};

const DEFAULT_QUOTAS: TenantQuota = NO_QUOTA_OVERRIDES;

const DEFAULT_SETTINGS: TenantSettings = {
  allowJoinRequests: true,
  notifyOnJoinRequest: true,
  notifyViaEmail: true,
  inviteExpiryDaysDefault: 7,
};

export type TenantNotificationPreferenceKey = keyof TenantNotificationPreferences;

export const TENANT_NOTIFICATION_PREFERENCE_KEYS: TenantNotificationPreferenceKey[] = [
  'membershipEventsEmail',
  'membershipEventsPush',
  'joinRequestEmail',
  'joinRequestPush',
  'usageAlertEmail',
  'usageAlertWhatsApp',
  'usageAlertSlack',
];

export const DEFAULT_TENANT_NOTIFICATION_PREFERENCES: TenantNotificationPreferences = {
  membershipEventsEmail: true,
  membershipEventsPush: true,
  joinRequestEmail: true,
  joinRequestPush: true,
  usageAlertEmail: true,
  usageAlertWhatsApp: true,
  usageAlertSlack: true,
};

export function normalizeTenantNotificationPreferences(
  raw?: Partial<TenantNotificationPreferences> | null,
): TenantNotificationPreferences {
  const normalized: TenantNotificationPreferences = { ...DEFAULT_TENANT_NOTIFICATION_PREFERENCES };
  if (raw && typeof raw === 'object') {
    for (const key of TENANT_NOTIFICATION_PREFERENCE_KEYS) {
      const value = raw[key];
      if (typeof value === 'boolean') {
        normalized[key] = value;
      }
    }
  }
  return normalized;
}

function slugifyName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 6);
  return base ? `${base}-${suffix}` : `center-${suffix}`;
}

function generateTenantCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 7; i += 1) {
    const idx = Math.floor(Math.random() * alphabet.length);
    code += alphabet[idx];
  }
  return code;
}

function membershipDocId(tenantId: string, userId: string): string {
  return `${tenantId}_${userId}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
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

class TenantService {
  private tenantRef = collection(firestore, TENANT_COLLECTION);

  private membershipRef = collection(firestore, MEMBERSHIP_COLLECTION);

  private joinRequestRef = collection(firestore, JOIN_REQUEST_COLLECTION);

  private inviteRef = collection(firestore, INVITE_COLLECTION);

  private codeRef = collection(firestore, CODE_COLLECTION);

  private auditRef = collection(firestore, AUDIT_COLLECTION);

  private membershipEmailCache = new Map<string, { fetchedAt: number; results: Map<string, boolean> }>();

  private createStatusEvent(
    status: TenantMembershipStatus,
    context?: MembershipStatusEventContext,
  ): TenantMembershipStatusEvent {
    const event: TenantMembershipStatusEvent = {
      status,
      at: context?.at ?? new Date().toISOString(),
    };
    if (context?.actorId) {
      event.actorId = context.actorId;
    }
    if (context?.actorEmail) {
      event.actorEmail = context.actorEmail;
    }
    if (context?.actorName) {
      event.actorName = context.actorName;
    }
    if (context?.reason) {
      event.reason = context.reason;
    }
    return event;
  }

  async createTenant(input: CreateTenantInput): Promise<Tenant> {
    try {
      const now = new Date().toISOString();
      const slug = slugifyName(input.name);
      const code = generateTenantCode();

      const tenantDoc = doc(this.tenantRef);
      const billingTier: Tenant['billingTier'] = 'free';
      const tenantData: Omit<Tenant, 'id'> = {
        name: input.name.trim(),
        slug,
        code,
        ownerUserId: input.ownerUserId,
        ownerEmail: input.ownerEmail.toLowerCase(),
        defaultCurrency: input.defaultCurrency || 'INR',
        contactEmail: input.contactEmail || input.ownerEmail,
        status: 'active',
        billingTier,
        quotas: NO_QUOTA_OVERRIDES,
        settings: { ...DEFAULT_SETTINGS },
        onboardingProgress: {
          dismissedChecklistItems: [],
          lastReviewedAt: now,
        },
        notificationPreferences: { ...DEFAULT_TENANT_NOTIFICATION_PREFERENCES },
        createdAt: now,
        updatedAt: now,
      };

      if (input.address && input.address.trim()) {
        tenantData.address = input.address.trim();
      }
      if (input.timezone && input.timezone.trim()) {
        tenantData.timezone = input.timezone.trim();
      }
      if (input.contactPhone && input.contactPhone.trim()) {
        tenantData.contactPhone = input.contactPhone.trim();
      }
      if (typeof input.logoUrl === 'string' && input.logoUrl.trim()) {
        tenantData.logoUrl = input.logoUrl.trim();
      }
      if (typeof input.heroImageUrl === 'string' && input.heroImageUrl.trim()) {
        tenantData.heroImageUrl = input.heroImageUrl.trim();
      }
      if (input.theme) {
        tenantData.theme = input.theme;
      }

      await setDoc(tenantDoc, tenantData);

      const ownerStatusEvent = this.createStatusEvent('active', {
        actorId: input.ownerUserId,
        actorEmail: input.ownerEmail.toLowerCase(),
        actorName: input.ownerEmail.split('@')[0],
        reason: 'tenant_owner_created',
        at: now,
      });

      await setDoc(doc(this.membershipRef, membershipDocId(tenantDoc.id, input.ownerUserId)), {
        tenantId: tenantDoc.id,
        userId: input.ownerUserId,
        email: input.ownerEmail.toLowerCase(),
        displayName: input.ownerEmail.split('@')[0],
        role: 'owner',
        status: 'active',
        createdAt: now,
        updatedAt: now,
        statusHistory: [ownerStatusEvent],
      } satisfies Omit<TenantMembership, 'id'>);

      await this.createAuditEntry({
        tenantId: tenantDoc.id,
        actorId: input.ownerUserId,
        actorEmail: input.ownerEmail,
        action: 'tenant_created',
        targetId: tenantDoc.id,
        targetType: 'tenant',
      });

      return { id: tenantDoc.id, ...tenantData };
    } catch (error) {
      logger.error('tenantService.createTenant failed', error);
      throw new Error('Failed to create coaching center');
    }
  }

  async updateTenant(input: UpdateTenantInput): Promise<void> {
    try {
      const { id, updatedBy, ...fields } = input;
      await updateDoc(doc(this.tenantRef, id), {
        ...fields,
        updatedAt: new Date().toISOString(),
      });
      await this.createAuditEntry({
        tenantId: id,
        actorId: updatedBy || 'system',
        action: 'tenant_updated',
        targetId: id,
        targetType: 'tenant',
        metadata: fields,
      });
    } catch (error) {
      logger.error('tenantService.updateTenant failed', error);
      throw new Error('Failed to update coaching center');
    }
  }

  async updateNotificationPreferences(params: {
    tenantId: string;
    notificationPreferences: Partial<TenantNotificationPreferences>;
    metadata?: {
      initiatedFrom?: string;
      actorName?: string;
      reason?: string;
    };
  }): Promise<{
    notificationPreferences: TenantNotificationPreferences;
    changedKeys: TenantNotificationPreferenceKey[];
  }> {
    try {
      const response = await tenantBackendClient.updateTenantNotificationPreferences({
        tenantId: params.tenantId,
        notificationPreferences: params.notificationPreferences,
        metadata: params.metadata,
      });
      return {
        notificationPreferences: normalizeTenantNotificationPreferences(response.notificationPreferences),
        changedKeys: Array.isArray(response.changedKeys) ? response.changedKeys : [],
      };
    } catch (error) {
      logger.error('tenantService.updateNotificationPreferences failed', error);
      throw new Error('Failed to update notification preferences');
    }
  }

  async getTenantById(id: string): Promise<Tenant | null> {
    try {
      const snap = await getDoc(doc(this.tenantRef, id));
      if (!snap.exists()) {
        return null;
      }
      const data = snap.data() || {};
      const tenant = { id: snap.id, ...data } as Tenant;
      tenant.notificationPreferences = normalizeTenantNotificationPreferences(
        (data.notificationPreferences as Partial<TenantNotificationPreferences> | undefined) ?? undefined,
      );
      return tenant;
    } catch (error) {
      logger.error('tenantService.getTenantById failed', error);
      throw new Error('Failed to load coaching center');
    }
  }

  async getTenantsByIds(ids: string[]): Promise<Tenant[]> {
    const results: Tenant[] = [];
    for (const id of ids) {
      const tenant = await this.getTenantById(id);
      if (tenant) {
        results.push(tenant);
      }
    }
    return results;
  }

  async getMembershipsForUser(userId: string): Promise<TenantMembership[]> {
    try {
      const q = query(this.membershipRef, where('userId', '==', userId));
      const snapshot = await getDocs(q);
      return snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      })) as TenantMembership[];
    } catch (error) {
      logger.error('tenantService.getMembershipsForUser failed', error);
      throw new Error('Failed to load coaching centers');
    }
  }

  listenToMembershipsForUser(
    userId: string,
    onSuccess: (memberships: TenantMembership[]) => void,
    onError?: (error: Error) => void,
  ): () => void {
    const q = query(this.membershipRef, where('userId', '==', userId));
    return onSnapshot(
      q,
      (snapshot) => {
        const memberships = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        })) as TenantMembership[];
        onSuccess(memberships);
      },
      (error) => {
        logger.error('tenantService.listenToMembershipsForUser failed', error);
        onError?.(error as Error);
      },
    );
  }

  async getActiveMembershipsForTenant(tenantId: string): Promise<TenantMembership[]> {
    try {
      const q = query(
        this.membershipRef,
        where('tenantId', '==', tenantId),
        where('status', '==', 'active'),
      );
      const snapshot = await getDocs(q);
      return snapshot.docs.map((docSnap) => ({
        id: docSnap.id,
        ...docSnap.data(),
      })) as TenantMembership[];
    } catch (error) {
      logger.error('tenantService.getActiveMembershipsForTenant failed', error);
      throw new Error('Failed to load coaching center members');
    }
  }

  async ensureMembership(
    tenantId: string,
    userId: string,
    email: string,
    role: TenantMembershipRole,
    context?: MembershipStatusEventContext,
  ): Promise<void> {
    const now = new Date().toISOString();
    const normalizedEmail = email.toLowerCase();
    const docId = membershipDocId(tenantId, userId);
    const membershipDocRef = doc(this.membershipRef, docId);
    const existingSnap = await getDoc(membershipDocRef);
    const existingMembership = existingSnap.exists() ? (existingSnap.data() as TenantMembership) : null;
    const alreadyActive = existingMembership?.status === 'active';
    if (!existingMembership || !alreadyActive) {
      await this.assertSeatAvailable(tenantId);
    }
    const payload: Record<string, unknown> = {
      tenantId,
      userId,
      email: normalizedEmail,
      role,
      status: 'active',
      updatedAt: now,
    };

    if (!existingMembership) {
      payload.createdAt = now;
      payload.statusHistory = [
        this.createStatusEvent('active', {
          actorId: context?.actorId ?? userId,
          actorEmail: context?.actorEmail ?? normalizedEmail,
          actorName: context?.actorName,
          reason: context?.reason ?? 'membership_created',
          at: now,
        }),
      ];
    } else if (!alreadyActive) {
      payload.statusHistory = arrayUnion(
        this.createStatusEvent('active', {
          actorId: context?.actorId ?? userId,
          actorEmail: context?.actorEmail ?? normalizedEmail,
          actorName: context?.actorName,
          reason: context?.reason ?? `status_changed_from_${existingMembership.status}`,
          at: now,
        }),
      );
    }

    await setDoc(membershipDocRef, payload, { merge: true });
  }

  async updateMembershipRole(
    tenantId: string,
    userId: string,
    role: TenantMembershipRole,
    options?: MembershipAdminActionOptions,
  ): Promise<void> {
    try {
      const initiatedFrom = resolveMembershipActionInitiator(options?.initiatedFrom);
      await tenantBackendClient.updateMembershipRole({
        tenantId,
        userId,
        role,
        metadata: {
          reason: options?.reason,
          initiatedFrom,
          actorName: options?.actorName,
        },
      });
    } catch (error) {
      logger.error('tenantService.updateMembershipRole failed', error);
      throw new Error('Failed to update member role');
    }
  }

  async updateMembershipStatus(
    tenantId: string,
    userId: string,
    status: BackendManagedMembershipStatus,
    options?: MembershipAdminActionOptions,
  ): Promise<void> {
    try {
      const initiatedFrom = resolveMembershipActionInitiator(options?.initiatedFrom);
      await tenantBackendClient.updateMembershipStatus({
        tenantId,
        userId,
        status,
        metadata: {
          reason: options?.reason,
          initiatedFrom,
          actorName: options?.actorName,
        },
      });
    } catch (error) {
      logger.error('tenantService.updateMembershipStatus failed', error);
      throw new Error('Failed to update member status');
    }
  }

  async leaveMembership(
    tenantId: string,
    userId: string,
    actorEmail?: string,
    options?: { tenantName?: string },
  ): Promise<void> {
    const docId = membershipDocId(tenantId, userId);
    const membershipRef = doc(this.membershipRef, docId);
    try {
      const snapshot = await getDoc(membershipRef);
      if (!snapshot.exists()) {
        throw new Error('Membership not found');
      }
      const membership = snapshot.data() as TenantMembership;
      const normalizedRole = (membership.role || '').toString().toLowerCase();
      if (normalizedRole === 'owner') {
        throw new Error('Owners must transfer or downgrade their role before leaving the coaching center.');
      }
      const nowIso = new Date().toISOString();
      const isPendingRequest = membership.status === 'pending_request';
      const leaveReason = isPendingRequest ? 'request_withdrawn' : 'self_leave';

      if (isPendingRequest) {
        const fallbackAt = membership.updatedAt || membership.createdAt || nowIso;
        const normalizedHistory: TenantMembershipStatusEvent[] = [];
        if (Array.isArray(membership.statusHistory)) {
          membership.statusHistory.forEach((event) => {
            if (!event || typeof event !== 'object' || !('status' in event) || !event.status) {
              return;
            }
            let at = fallbackAt;
            if (typeof event.at === 'string') {
              const parsed = Date.parse(event.at);
              if (!Number.isNaN(parsed)) {
                at = new Date(parsed).toISOString();
              }
            }
            const normalizedEvent: TenantMembershipStatusEvent = {
              status: event.status as TenantMembershipStatus,
              at,
            };
            if (typeof event.actorId === 'string' && event.actorId) {
              normalizedEvent.actorId = event.actorId;
            }
            if (typeof event.actorEmail === 'string' && event.actorEmail) {
              normalizedEvent.actorEmail = event.actorEmail;
            }
            if (typeof event.actorName === 'string' && event.actorName) {
              normalizedEvent.actorName = event.actorName;
            }
            if (typeof event.reason === 'string' && event.reason) {
              normalizedEvent.reason = event.reason;
            }
            normalizedHistory.push(normalizedEvent);
          });
        }

        if (normalizedHistory.length) {
          let latestPendingIndex = -1;
          let latestPendingAt = Number.NEGATIVE_INFINITY;
          normalizedHistory.forEach((event, index) => {
            if (event.status !== 'pending_request') {
              return;
            }
            const timestamp = Date.parse(event.at);
            const value = Number.isNaN(timestamp) ? 0 : timestamp;
            if (value >= latestPendingAt) {
              latestPendingAt = value;
              latestPendingIndex = index;
            }
          });
          if (latestPendingIndex !== -1) {
            normalizedHistory.splice(latestPendingIndex, 1);
          }
        }

        if (!normalizedHistory.length) {
          await deleteDoc(membershipRef);
        } else {
          const sortedHistory = [...normalizedHistory].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
          const latestEvent = sortedHistory[sortedHistory.length - 1];
          await updateDoc(membershipRef, {
            status: latestEvent.status,
            updatedAt: nowIso,
            statusHistory: sortedHistory,
          });
        }

        try {
          const pendingRequestsSnap = await getDocs(
            query(
              this.joinRequestRef,
              where('tenantId', '==', tenantId),
              where('userId', '==', userId),
              where('status', '==', 'pending'),
              limit(10),
            ),
          );
          const deletions = pendingRequestsSnap.docs.map((docSnap) => deleteDoc(docSnap.ref));
          await Promise.all(deletions);
        } catch (joinRequestCleanupError) {
          logger.debug('tenantService.leaveMembership: failed to cleanup join request on withdraw', joinRequestCleanupError);
        }
      } else {
        if (membership.status === 'revoked') {
          return;
        }
        await updateDoc(membershipRef, {
          status: 'revoked',
          updatedAt: nowIso,
          statusHistory: arrayUnion(
            this.createStatusEvent('revoked', {
              actorId: userId,
              actorEmail,
              reason: leaveReason,
              at: nowIso,
            }),
          ),
        });
      }
      await this.createAuditEntry({
        tenantId,
        actorId: userId,
        actorEmail,
        action: 'membership_revoked',
        targetId: docId,
        targetType: 'membership',
        metadata: {
          previousRole: membership.role,
          previousStatus: membership.status,
          reason: leaveReason,
        },
      });

      const initiatedFrom = Platform.OS === 'web' ? 'web' : 'mobile';
      void teamMembershipNotifier
        .notifyChange({
          tenantId,
          tenantName: options?.tenantName,
          action: 'removed',
          targetEmail: membership.email,
          targetRole: membership.role,
          metadata: {
            displayName: membership.displayName,
            reason: leaveReason,
            initiatedFrom,
          },
        })
        .catch((error) => logger.debug('tenantService: notify leave membership skipped', error));
    } catch (error) {
      logger.error('tenantService.leaveMembership failed', error);
      throw new Error('Failed to leave coaching center');
    }
  }

  async createJoinRequest(input: CreateJoinRequestInput): Promise<TenantJoinRequest> {
    try {
      const now = new Date();
      const expires = new Date(now);
      expires.setDate(expires.getDate() + 30);

      const requestData: Omit<TenantJoinRequest, 'id'> = {
        tenantId: input.tenantId,
        tenantName: input.tenantName,
        userId: input.userId,
        email: input.email.toLowerCase(),
        displayName: input.displayName,
        message: input.message,
        status: 'pending',
        requestedAt: now.toISOString(),
        expiresAt: expires.toISOString(),
      };

      const ref = await addDoc(this.joinRequestRef, requestData);
      void tenantBackendClient
        .notifyJoinRequestSubmitted({ tenantId: input.tenantId, requestId: ref.id })
        .catch((error) => logger.debug('tenantService: join request notify skipped', error));
      return { id: ref.id, ...requestData };
    } catch (error) {
      logger.error('tenantService.createJoinRequest failed', error);
      throw new Error('Failed to submit join request');
    }
  }

  async approveJoinRequest(
    requestId: string,
    approverUserId: string,
    role: TenantMembershipRole,
    options?: { actorName?: string },
  ): Promise<void> {
    try {
      const requestSnap = await getDoc(doc(this.joinRequestRef, requestId));
      if (!requestSnap.exists()) {
        throw new Error('Join request not found');
      }
      const request = requestSnap.data() as TenantJoinRequest;
      await tenantBackendClient.approveJoinRequest({
        tenantId: request.tenantId,
        requestId,
        role,
        reviewerName: options?.actorName,
        metadata: {
          actorName: options?.actorName,
          initiatedFrom: Platform.OS === 'web' ? 'web' : 'mobile',
          reason: 'join_request_approved',
        },
      });
    } catch (error) {
      logger.error('tenantService.approveJoinRequest failed', error);
      if (error instanceof TenantBackendError) {
        throw error;
      }
      throw new Error('Failed to approve join request');
    }
  }

  async rejectJoinRequest(
    requestId: string,
    approverUserId: string,
    options?: { actorName?: string },
  ): Promise<void> {
    try {
      const requestSnap = await getDoc(doc(this.joinRequestRef, requestId));
      if (!requestSnap.exists()) {
        throw new Error('Join request not found');
      }
      const request = requestSnap.data() as TenantJoinRequest;
      await tenantBackendClient.rejectJoinRequest({
        tenantId: request.tenantId,
        requestId,
        reviewerName: options?.actorName,
        reason: 'join_request_rejected',
        metadata: {
          actorName: options?.actorName,
          initiatedFrom: Platform.OS === 'web' ? 'web' : 'mobile',
          reason: 'join_request_rejected',
        },
      });
    } catch (error) {
      logger.error('tenantService.rejectJoinRequest failed', error);
      if (error instanceof TenantBackendError) {
        throw error;
      }
      throw new Error('Failed to reject join request');
    }
  }

  async cacheSelectedTenant(tenantId: string | null): Promise<void> {
    try {
      if (!tenantId) {
        await AsyncStorage.removeItem(STORAGE_KEYS.selectedTenantId);
        return;
      }
      await AsyncStorage.setItem(STORAGE_KEYS.selectedTenantId, tenantId);
    } catch (error) {
      logger.warn('tenantService.cacheSelectedTenant failed', error);
    }
  }

  async getCachedSelectedTenant(): Promise<string | null> {
    try {
      return (await AsyncStorage.getItem(STORAGE_KEYS.selectedTenantId)) || null;
    } catch (error) {
      logger.warn('tenantService.getCachedSelectedTenant failed', error);
      return null;
    }
  }

  async cacheMemberships(memberships: TenantMembership[]): Promise<void> {
    try {
      await AsyncStorage.setItem(
        STORAGE_KEYS.cachedTenantMemberships,
        JSON.stringify(memberships),
      );
    } catch (error) {
      logger.warn('tenantService.cacheMemberships failed', error);
    }
  }

  async getCachedMemberships(): Promise<TenantMembership[]> {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEYS.cachedTenantMemberships);
      if (!raw) {
        return [];
      }
      return JSON.parse(raw) as TenantMembership[];
    } catch (error) {
      logger.warn('tenantService.getCachedMemberships failed', error);
      return [];
    }
  }

  private async readNotificationPreferenceDrafts(): Promise<Record<string, TenantNotificationPreferences>> {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEYS.tenantNotificationPreferenceDrafts);
      if (!raw) {
        return {};
      }
      const parsed = JSON.parse(raw) as Record<string, Partial<TenantNotificationPreferences>>;
      const normalized: Record<string, TenantNotificationPreferences> = {};
      Object.entries(parsed).forEach(([tenantId, prefs]) => {
        normalized[tenantId] = normalizeTenantNotificationPreferences(prefs);
      });
      return normalized;
    } catch (error) {
      logger.warn('tenantService.readNotificationPreferenceDrafts failed', error);
      return {};
    }
  }

  private async writeNotificationPreferenceDrafts(
    drafts: Record<string, TenantNotificationPreferences>
  ): Promise<void> {
    try {
      if (!Object.keys(drafts).length) {
        await AsyncStorage.removeItem(STORAGE_KEYS.tenantNotificationPreferenceDrafts);
        return;
      }
      await AsyncStorage.setItem(
        STORAGE_KEYS.tenantNotificationPreferenceDrafts,
        JSON.stringify(drafts)
      );
    } catch (error) {
      logger.warn('tenantService.writeNotificationPreferenceDrafts failed', error);
    }
  }

  async getNotificationPreferenceDraft(
    tenantId: string
  ): Promise<TenantNotificationPreferences | null> {
    if (!tenantId) {
      return null;
    }
    const drafts = await this.readNotificationPreferenceDrafts();
    const draft = drafts[tenantId];
    return draft ? { ...draft } : null;
  }

  async setNotificationPreferenceDraft(
    tenantId: string,
    prefs: TenantNotificationPreferences | null
  ): Promise<void> {
    if (!tenantId) {
      return;
    }
    const drafts = await this.readNotificationPreferenceDrafts();
    if (!prefs) {
      if (drafts[tenantId]) {
        delete drafts[tenantId];
        await this.writeNotificationPreferenceDrafts(drafts);
      }
      return;
    }
    drafts[tenantId] = { ...prefs };
    await this.writeNotificationPreferenceDrafts(drafts);
  }

  // TODO: Replace this client-side email membership lookup with a backend issued assertion once
  // tenant-bound notification checks move fully server-side.
  async isEmailActiveMemberOfTenant(tenantId: string, email: string): Promise<boolean> {
    if (!tenantId || !email) {
      return false;
    }

    const normalizedEmail = email.trim().toLowerCase();
    const now = Date.now();
    const CACHE_TTL_MS = 60 * 1000;
    const cacheEntry = this.membershipEmailCache.get(tenantId);
    if (cacheEntry && now - cacheEntry.fetchedAt < CACHE_TTL_MS) {
      const cachedResult = cacheEntry.results.get(normalizedEmail);
      if (cachedResult !== undefined) {
        return cachedResult;
      }
    }

    try {
      const membershipQuery = query(
        this.membershipRef,
        where('tenantId', '==', tenantId),
        where('status', '==', 'active'),
        where('email', '==', normalizedEmail),
        limit(1)
      );

      const snapshot = await getDocs(membershipQuery);
      const isMember = !snapshot.empty;

      let nextEntry = cacheEntry;
      if (!nextEntry || now - nextEntry.fetchedAt >= CACHE_TTL_MS) {
        nextEntry = { fetchedAt: now, results: new Map<string, boolean>() };
      }
      nextEntry.results.set(normalizedEmail, isMember);
      nextEntry.fetchedAt = now;
      this.membershipEmailCache.set(tenantId, nextEntry);

      return isMember;
    } catch (error) {
      logger.warn('tenantService.isEmailActiveMemberOfTenant failed', {
        tenantId,
        email: normalizedEmail,
        error,
      });
      return false;
    }
  }

  private async findPendingInviteForEmail(tenantId: string, email: string): Promise<TenantInvite | null> {
    if (!tenantId || !email) {
      return null;
    }
    const normalizedEmail = email.trim().toLowerCase();
    try {
      const pendingInvitesQuery = query(
        this.inviteRef,
        where('tenantId', '==', tenantId),
        where('status', '==', 'pending'),
      );
      const snapshot = await getDocs(pendingInvitesQuery);
      for (const docSnap of snapshot.docs) {
        const data = docSnap.data() as Omit<TenantInvite, 'id'>;
        const invite = { id: docSnap.id, ...data } as TenantInvite;
        const inviteEmail = (invite.email || '').trim().toLowerCase();
        if (inviteEmail === normalizedEmail) {
          return invite;
        }
      }
      return null;
    } catch (error) {
      logger.warn('tenantService.findPendingInviteForEmail failed', {
        tenantId,
        email: normalizedEmail,
        error,
      });
      throw new Error('Unable to verify existing invites. Please try again.');
    }
  }

  private async getActiveMembershipCount(tenantId: string): Promise<number> {
    const q = query(
      this.membershipRef,
      where('tenantId', '==', tenantId),
      where('status', '==', 'active'),
    );
    const snapshot = await getDocs(q);
    let count = 0;
    snapshot.docs.forEach((docSnap) => {
      const data = docSnap.data() as Partial<TenantMembership>;
      const role = data.role;
      if (role === 'owner' || role === 'admin' || role === 'staff') {
        count += 1;
      }
    });
    return count;
  }

  private async getPendingSeatInviteCount(tenantId: string): Promise<number> {
    const q = query(
      this.inviteRef,
      where('tenantId', '==', tenantId),
      where('status', '==', 'pending'),
    );
    const snapshot = await getDocs(q);
    let count = 0;
    snapshot.docs.forEach((docSnap) => {
      const data = docSnap.data() as Partial<TenantInvite>;
      const role = data.role;
      if (role === 'owner' || role === 'admin' || role === 'staff') {
        count += 1;
      }
    });
    return count;
  }

  private async assertSeatAvailable(tenantId: string): Promise<void> {
    const tenant = await this.getTenantById(tenantId);
    if (!tenant) {
      throw new Error('Coaching center not found');
    }
    // Quotas are manual overrides; effective plan limits are enforced on the backend.
    // Client-side checks should not attempt to re-implement plan tiers.
    const seatLimit = tenant.quotas?.maxStaff ?? null;
    if (!seatLimit || seatLimit <= 0) {
      return;
    }
    const [activeCount, pendingInviteCount] = await Promise.all([
      this.getActiveMembershipCount(tenantId),
      this.getPendingSeatInviteCount(tenantId),
    ]);
    if (activeCount + pendingInviteCount >= seatLimit) {
      throw new Error(
        `Staff seat limit reached for this plan (${seatLimit}). Remove a member, revoke a pending invite, or upgrade to add more seats.`,
      );
    }
  }

  async fetchTenantsForMemberships(memberships: TenantMembership[]): Promise<Tenant[]> {
    const tenantIds = Array.from(new Set(memberships.map((m) => m.tenantId)));
    return this.getTenantsByIds(tenantIds);
  }

  async findTenantByCode(code: string): Promise<Tenant | null> {
    try {
      const q = query(this.tenantRef, where('code', '==', code.toUpperCase()), limit(1));
      const snapshot = await getDocs(q);
      if (snapshot.empty) {
        return null;
      }
      const docSnap = snapshot.docs[0];
      const data = docSnap.data() || {};
      const tenant = { id: docSnap.id, ...data } as Tenant;
      tenant.notificationPreferences = normalizeTenantNotificationPreferences(
        (data.notificationPreferences as Partial<TenantNotificationPreferences> | undefined) ?? undefined,
      );
      return tenant;
    } catch (error) {
      logger.error('tenantService.findTenantByCode failed', error);
      throw new Error('Failed to lookup coaching center');
    }
  }

  listenToJoinRequests(
    tenantId: string,
    onSuccess: (requests: TenantJoinRequest[]) => void,
    onError?: (error: Error) => void,
  ): () => void {
    const q = query(
      this.joinRequestRef,
      where('tenantId', '==', tenantId),
      orderBy('requestedAt', 'desc'),
    );
    return onSnapshot(
      q,
      (snapshot) => {
        const requests = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        })) as TenantJoinRequest[];
        onSuccess(requests);
      },
      (error) => {
        logger.error('tenantService.listenToJoinRequests failed', error);
        onError?.(error as Error);
      },
    );
  }

  async createInvite(params: {
    tenantId: string;
    email: string;
    role: TenantMembershipRole;
    issuedBy: string;
    expiresInDays?: number;
    message?: string;
  }): Promise<TenantInvite> {
    const normalizedEmail = params.email.trim().toLowerCase();
    const alreadyMember = await this.isEmailActiveMemberOfTenant(params.tenantId, normalizedEmail);
    if (alreadyMember) {
      throw new Error('This email already has access to this workspace. Remove them before inviting again.');
    }
    const existingInvite = await this.findPendingInviteForEmail(params.tenantId, normalizedEmail);
    if (existingInvite) {
      throw new Error('An invite is already pending for this email. Resend or revoke it before creating a new link.');
    }
    try {
      const result = await tenantBackendClient.createInvite({
        tenantId: params.tenantId,
        email: normalizedEmail,
        role: params.role,
        expiresInDays: params.expiresInDays,
        message: params.message,
      });
      const invite = (result?.invite || {}) as TenantInvite & { id: string };
      if (!invite?.id) {
        throw new Error('Invite creation response invalid');
      }
      tenantBackendClient
        .notifyTenantInvite({ tenantId: params.tenantId, inviteId: invite.id })
        .catch((error) => logger.debug('tenantService: invite email notification skipped', error));
      return invite;
    } catch (error) {
      logger.error('tenantService.createInvite failed', error);
      if (error instanceof TenantBackendError) {
        throw error;
      }
      throw new Error('Failed to create invite');
    }
  }

  async resendInvite(inviteId: string, actorId: string): Promise<void> {
    const inviteSnap = await getDoc(doc(this.inviteRef, inviteId));
    if (!inviteSnap.exists()) {
      throw new Error('Invite not found');
    }
    const invite = inviteSnap.data() as TenantInvite;
    try {
      await tenantBackendClient.resendInvite({ tenantId: invite.tenantId, inviteId });
      await tenantBackendClient
        .notifyTenantInvite({ tenantId: invite.tenantId, inviteId })
        .catch((error) => logger.debug('tenantService: invite email notification skipped', error));
    } catch (error) {
      logger.error('tenantService.resendInvite failed', error);
      if (error instanceof TenantBackendError) {
        throw error;
      }
      throw new Error('Failed to resend invite');
    }
  }

  async acceptInvite(token: string): Promise<void> {
    const normalizedToken = token?.trim();
    if (!normalizedToken) {
      throw new Error('Invite token missing');
    }
    try {
      await tenantBackendClient.acceptInvite({ token: normalizedToken });
    } catch (error) {
      logger.error('tenantService.acceptInvite failed', error);
      if (error instanceof TenantBackendError) {
        throw error;
      }
      throw new Error('Failed to accept invite');
    }
  }

  async revokeInvite(inviteId: string, actorId: string): Promise<void> {
    const inviteSnap = await getDoc(doc(this.inviteRef, inviteId));
    if (!inviteSnap.exists()) {
      throw new Error('Invite not found');
    }
    const invite = inviteSnap.data() as TenantInvite;
    try {
      await tenantBackendClient.revokeInvite({ tenantId: invite.tenantId, inviteId });
    } catch (error) {
      logger.error('tenantService.revokeInvite failed', { inviteId, actorId, error });
      if (error instanceof TenantBackendError) {
        throw error;
      }
      throw new Error('Failed to revoke invite');
    }
  }

  async findInviteByToken(token: string): Promise<TenantInvite | null> {
    const q = query(this.inviteRef, where('token', '==', token), limit(1));
    const snapshot = await getDocs(q);
    if (snapshot.empty) {
      return null;
    }
    return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as TenantInvite;
  }

  async createTenantCode(params: {
    tenantId: string;
    createdBy: string;
    expiresInDays?: number;
    usageCap?: number | null;
  }): Promise<TenantCode> {
    const now = new Date();
    const expires = params.expiresInDays
      ? new Date(now.getTime() + params.expiresInDays * 24 * 60 * 60 * 1000)
      : undefined;

    const activeCodesSnap = await getDocs(
      query(
        this.codeRef,
        where('tenantId', '==', params.tenantId),
        where('status', '==', 'active'),
        limit(MAX_ACTIVE_JOIN_CODES + 1),
      ),
    );
    if (activeCodesSnap.size >= MAX_ACTIVE_JOIN_CODES) {
      throw new Error('Maximum active join codes reached. Revoke or expire an existing code to generate a new one.');
    }

    const codeData: Omit<TenantCode, 'id'> = {
      tenantId: params.tenantId,
      code: generateTenantCode(),
      createdBy: params.createdBy,
      createdAt: now.toISOString(),
      expiresAt: expires?.toISOString(),
      usageCount: 0,
      usageCap: typeof params.usageCap === 'number' ? params.usageCap : null,
      status: 'active',
    };

    const docRef = await addDoc(this.codeRef, codeData);
    await this.createAuditEntry({
      tenantId: params.tenantId,
      actorId: params.createdBy,
      action: 'invite_regenerated',
      targetId: docRef.id,
      targetType: 'code',
      metadata: { code: codeData.code },
    });
    return { id: docRef.id, ...codeData };
  }

  async incrementCodeUsage(codeId: string): Promise<void> {
    const code = await this.getCode(codeId);
    if (!code) {
      throw new Error('Tenant code not found');
    }
    await updateDoc(doc(this.codeRef, codeId), {
      usageCount: (code.usageCount || 0) + 1,
      lastUsedAt: new Date().toISOString(),
    });
  }

  async getCode(codeId: string): Promise<TenantCode | null> {
    const snap = await getDoc(doc(this.codeRef, codeId));
    if (!snap.exists()) {
      return null;
    }
    return { id: snap.id, ...snap.data() } as TenantCode;
  }

  async revokeCode(codeId: string, actorId: string): Promise<void> {
    const code = await this.getCode(codeId);
    if (!code) {
      throw new Error('Tenant code not found');
    }
    await updateDoc(doc(this.codeRef, codeId), {
      status: 'revoked',
      updatedAt: new Date().toISOString(),
    });
    await this.createAuditEntry({
      tenantId: code.tenantId,
      actorId,
      action: 'invite_regenerated',
      targetId: codeId,
      targetType: 'code',
    });
  }

  async expireStaleInvites(cutoffDate: Date): Promise<void> {
    const q = query(
      this.inviteRef,
      where('status', '==', 'pending'),
      where('expiresAt', '<', cutoffDate.toISOString()),
    );
    const snapshot = await getDocs(q);
    const tasks = snapshot.docs.map((docSnap) =>
      updateDoc(docSnap.ref, {
        status: 'expired',
      }),
    );
    await Promise.all(tasks);
  }

  listenToInvites(
    tenantId: string,
    onSuccess: (invites: TenantInvite[]) => void,
    onError?: (error: Error) => void,
    limitCount: number = 50,
  ): () => void {
    const q = query(
      this.inviteRef,
      where('tenantId', '==', tenantId),
      orderBy('issuedAt', 'desc'),
      limit(limitCount),
    );
    return onSnapshot(
      q,
      (snapshot) => {
        const invites = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        })) as TenantInvite[];
        onSuccess(invites);
      },
      (error) => {
        logger.error('tenantService.listenToInvites failed', error);
        onError?.(error as Error);
      },
    );
  }

  listenToIncomingInvites(
    email: string,
    onSuccess: (invites: TenantInvite[]) => void,
    onError?: (error: Error) => void,
    limitCount: number = 25,
  ): () => void {
    const normalizedEmail = (email || '').trim().toLowerCase();
    if (!normalizedEmail) {
      onSuccess([]);
      return () => undefined;
    }

    // NOTE: Avoid `orderBy('issuedAt')` here.
    // Firestore requires a composite index for where(email==X) + orderBy(issuedAt),
    // which breaks local/dev projects unless an index is created.
    // Instead, fetch all invites for that email (typically small) and sort client-side.
    const q = query(this.inviteRef, where('email', '==', normalizedEmail));
    return onSnapshot(
      q,
      (snapshot) => {
        const invites = snapshot.docs
          .map((docSnap) => ({
            id: docSnap.id,
            ...docSnap.data(),
          }))
          .sort((a, b) => {
            const issuedA = typeof (a as any).issuedAt === 'string' ? Date.parse((a as any).issuedAt) : NaN;
            const issuedB = typeof (b as any).issuedAt === 'string' ? Date.parse((b as any).issuedAt) : NaN;
            if (Number.isNaN(issuedA) && Number.isNaN(issuedB)) return 0;
            if (Number.isNaN(issuedA)) return 1;
            if (Number.isNaN(issuedB)) return -1;
            return issuedB - issuedA;
          }) as TenantInvite[];

        onSuccess(invites.slice(0, Math.max(0, limitCount)));
      },
      (error) => {
        logger.error('tenantService.listenToIncomingInvites failed', error);
        onError?.(error as Error);
      },
    );
  }

  async rejectInvite(inviteId: string, actorId: string): Promise<void> {
    const normalizedInviteId = (inviteId || '').trim();
    if (!normalizedInviteId) {
      throw new Error('Invite id missing');
    }
    const inviteSnap = await getDoc(doc(this.inviteRef, normalizedInviteId));
    if (!inviteSnap.exists()) {
      throw new Error('Invite not found');
    }
    const invite = inviteSnap.data() as TenantInvite;

    const token = typeof (invite as any).token === 'string' ? String((invite as any).token).trim() : '';
    if (!token) {
      throw new Error('Invite token missing');
    }

    try {
      await tenantBackendClient.rejectInvite({ token });
    } catch (error) {
      logger.error('tenantService.rejectInvite failed', { inviteId, actorId, error });
      if (error instanceof TenantBackendError) {
        throw error;
      }
      throw new Error('Failed to reject invite');
    }
  }

  async rejectInviteByToken(token: string, actorId: string): Promise<void> {
    const normalizedToken = (token || '').trim();
    if (!normalizedToken) {
      throw new Error('Invite token missing');
    }

    try {
      await tenantBackendClient.rejectInvite({ token: normalizedToken });
    } catch (error) {
      logger.error('tenantService.rejectInviteByToken failed', { actorId, error });
      if (error instanceof TenantBackendError) {
        throw error;
      }
      throw new Error('Failed to reject invite');
    }
  }

  async syncIncomingInvitesToMembershipsForUser(params: {
    userId: string;
    email: string;
    displayName?: string;
    invites: TenantInvite[];
  }): Promise<void> {
    const userId = (params.userId || '').trim();
    const email = (params.email || '').trim().toLowerCase();
    if (!userId || !email) {
      return;
    }

    const invites = Array.isArray(params.invites) ? params.invites : [];
    const nowIso = new Date().toISOString();

    // Only the invitee can map an invite -> membership doc id because it requires the user's uid.
    // This mirrors how join-code claim updates tenantMemberships/{tenantId}_{uid}.
    for (const invite of invites) {
      if (!invite?.tenantId) {
        continue;
      }
      if (invite.status === 'accepted') {
        continue;
      }

      const nextStatus: TenantMembershipStatus | null =
        invite.status === 'pending'
          ? 'pending_invite'
          : invite.status === 'rejected'
            ? 'rejected'
            : null;

      if (!nextStatus) {
        continue;
      }

      const membershipId = membershipDocId(invite.tenantId, userId);
      const membershipRef = doc(this.membershipRef, membershipId);
      const snap = await getDoc(membershipRef);
      const existing = snap.exists() ? (snap.data() as Partial<TenantMembership>) : null;

      const existingStatus = (existing?.status as TenantMembershipStatus | undefined) ?? undefined;
      const existingRole = (existing?.role as TenantMembershipRole | undefined) ?? undefined;
      const existingCreatedAt = typeof existing?.createdAt === 'string' ? existing.createdAt : nowIso;
      const existingToken = typeof existing?.inviteToken === 'string' ? existing.inviteToken : undefined;
      const existingExpiresAt = existing?.inviteExpiresAt;
      const inviteAt =
        nextStatus === 'pending_invite'
          ? invite.issuedAt
          : invite.rejectedAt || invite.issuedAt || nowIso;

      const shouldUpdateStatus = existingStatus !== nextStatus;
      const shouldUpdateToken = nextStatus === 'pending_invite' && existingToken !== invite.token;
      const shouldUpdateExpiry =
        nextStatus === 'pending_invite' &&
        typeof invite.expiresAt === 'string' &&
        (typeof existingExpiresAt !== 'string' || existingExpiresAt !== invite.expiresAt);
      const shouldClearInviteFields =
        nextStatus === 'rejected' &&
        (typeof existingToken === 'string' || typeof existingExpiresAt === 'string' || typeof existing?.invitedBy === 'string');

      // Don't override an active membership role; otherwise keep it aligned with the invite.
      const shouldUpdateRole = existingStatus !== 'active' && existingRole !== invite.role;

      if (
        !snap.exists() ||
        shouldUpdateStatus ||
        shouldUpdateToken ||
        shouldUpdateExpiry ||
        shouldUpdateRole ||
        shouldClearInviteFields
      ) {
        const statusEvent = this.createStatusEvent(nextStatus, {
          at: typeof inviteAt === 'string' ? inviteAt : nowIso,
          actorId: nextStatus === 'pending_invite' ? invite.issuedBy : userId,
          actorEmail: nextStatus === 'pending_invite' ? undefined : email,
          actorName: nextStatus !== 'pending_invite' ? params.displayName : undefined,
          reason: nextStatus === 'pending_invite' ? 'invite_received' : 'invite_rejected_by_user',
        });

        if (!snap.exists()) {
          const payload: Omit<TenantMembership, 'id'> = {
            tenantId: invite.tenantId,
            userId,
            email,
            displayName: (params.displayName || email.split('@')[0] || email).slice(0, 120),
            role: invite.role,
            status: nextStatus,
            createdAt: existingCreatedAt,
            updatedAt: nowIso,
            statusHistory: [statusEvent],
          };

          if (nextStatus === 'pending_invite') {
            payload.inviteToken = invite.token;
            payload.inviteExpiresAt = invite.expiresAt;
            payload.invitedBy = invite.issuedBy;
          }
          await setDoc(membershipRef, payload);
        } else {
          const updatePayload: Record<string, unknown> = {
            updatedAt: nowIso,
          };
          if (shouldUpdateStatus) updatePayload.status = nextStatus;
          if (shouldUpdateRole) updatePayload.role = invite.role;

          if (nextStatus === 'pending_invite') {
            updatePayload.inviteToken = invite.token;
            updatePayload.inviteExpiresAt = invite.expiresAt;
            updatePayload.invitedBy = invite.issuedBy;
          } else if (nextStatus === 'rejected') {
            updatePayload.inviteToken = deleteField();
            updatePayload.inviteExpiresAt = deleteField();
            updatePayload.invitedBy = deleteField();
          }

          // Keep status history consistent with join-code claim behavior.
          updatePayload.statusHistory = arrayUnion(statusEvent);

          await setDoc(membershipRef, updatePayload, { merge: true });
        }
      }
    }
  }

  listenToCodes(
    tenantId: string,
    onSuccess: (codes: TenantCode[]) => void,
    onError?: (error: Error) => void,
    limitCount: number = 10,
  ): () => void {
    const q = query(
      this.codeRef,
      where('tenantId', '==', tenantId),
      orderBy('createdAt', 'desc'),
      limit(limitCount),
    );
    return onSnapshot(
      q,
      (snapshot) => {
        const codes = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        })) as TenantCode[];
        onSuccess(codes);
      },
      (error) => {
        logger.error('tenantService.listenToCodes failed', error);
        onError?.(error as Error);
      },
    );
  }

  async logAuditEvent(entry: Omit<TenantAuditLogEntry, 'id' | 'createdAt'>): Promise<void> {
    await this.createAuditEntry(entry);
  }

  private async createAuditEntry(entry: Omit<TenantAuditLogEntry, 'id' | 'createdAt'>): Promise<void> {
    try {
      const payload = stripUndefinedDeep({
        ...entry,
        createdAt: new Date().toISOString(),
      });
      await addDoc(this.auditRef, payload as any);
    } catch (error) {
      logger.warn('tenantService.createAuditEntry failed', error);
    }
  }
}

export const tenantService = new TenantService();
