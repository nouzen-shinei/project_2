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
type AuthServiceType = typeof import('../hooks/useAuthUnified').authService;
let __authService: AuthServiceType | null = null;
function getAuthService(): AuthServiceType {
  if (!__authService) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../hooks/useAuthUnified');
    __authService = mod.authService as AuthServiceType;
  }
  return __authService;
}

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

export interface UpdateTenantInput extends Partial<Omit<Tenant, 'id' | 'settings'>> {
  id: string;
  updatedBy?: string;
  // Settings is merged server-side, so callers may send only the keys they change.
  settings?: Partial<TenantSettings>;
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
  'usageAlertPush',
  'usageAlertWhatsApp',
  'usageAlertSlack',
];

export const DEFAULT_TENANT_NOTIFICATION_PREFERENCES: TenantNotificationPreferences = {
  membershipEventsEmail: true,
  membershipEventsPush: true,
  joinRequestEmail: true,
  joinRequestPush: true,
  usageAlertEmail: true,
  usageAlertPush: true,
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
    // Server-mediated (security-rules-hardening C1): the backend creates the
    // tenant doc, the owner membership, and the audit entry via the Admin SDK,
    // deriving the owner from the authenticated token. Clients can no longer
    // write `tenants`/`tenantMemberships` directly.
    try {
      const response = await tenantBackendClient.createTenant({
        name: input.name,
        defaultCurrency: input.defaultCurrency,
        contactEmail: input.contactEmail,
        contactPhone: input.contactPhone,
        address: input.address,
        timezone: input.timezone,
        logoUrl: input.logoUrl,
        heroImageUrl: input.heroImageUrl,
        theme: input.theme as unknown as Record<string, unknown> | undefined,
      });
      const tenant = { ...(response.tenant as any) } as Tenant;
      tenant.notificationPreferences = normalizeTenantNotificationPreferences(
        (tenant.notificationPreferences as Partial<TenantNotificationPreferences> | undefined) ?? undefined,
      );
      return tenant;
    } catch (error) {
      logger.error('tenantService.createTenant failed', error);
      throw new Error('Failed to create coaching center');
    }
  }

  async updateTenant(input: UpdateTenantInput): Promise<void> {
    // Server-mediated (security-rules-hardening C1): the backend owns writes to
    // the `tenants` collection and the audit trail. We forward only the
    // editable fields (identity, billing, quotas and counts are not settable).
    const { id, updatedBy: _updatedBy, ...fields } = input;
    try {
      await tenantBackendClient.updateTenant({
        tenantId: id,
        name: fields.name,
        contactEmail: fields.contactEmail,
        contactPhone: fields.contactPhone,
        address: fields.address,
        timezone: fields.timezone,
        defaultCurrency: fields.defaultCurrency,
        logoUrl: fields.logoUrl,
        heroImageUrl: fields.heroImageUrl,
        theme: fields.theme as unknown as Record<string, unknown> | undefined,
        branding: fields.branding as unknown as Record<string, unknown> | undefined,
        settings: fields.settings as unknown as Record<string, unknown> | undefined,
        onboardingProgress: fields.onboardingProgress as unknown as Record<string, unknown> | undefined,
      });
    } catch (error) {
      logger.error('tenantService.updateTenant failed', error);
      if (error instanceof TenantBackendError) {
        throw error;
      }
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
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    const attach = (context?: string) => {
      if (disposed) return;
      unsubscribe?.();
      unsubscribe = onSnapshot(
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

      if (context) {
        logger.debug('tenantService.listenToMembershipsForUser reattached', { context });
      }
    };

    attach('initial');
    const unregister = getAuthService().registerFirestoreReinit?.(() => attach('reinit'));

    return () => {
      disposed = true;
      unsubscribe?.();
      try {
        unregister?.();
      } catch {}
    };
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
    _userId: string,
    _actorEmail?: string,
    _options?: { tenantName?: string },
  ): Promise<void> {
    // Server-mediated (security-rules-hardening C1): the backend revokes the
    // caller's own membership (deriving the uid from the token), withdraws any
    // pending join request, writes the audit entry, and notifies tenant admins.
    // Owners are rejected server-side until they transfer/downgrade first.
    try {
      await tenantBackendClient.leaveTenant({ tenantId });
    } catch (error) {
      logger.error('tenantService.leaveMembership failed', error);
      if (error instanceof TenantBackendError) {
        throw new Error(error.message);
      }
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
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    const attach = (context?: string) => {
      if (disposed) return;
      unsubscribe?.();
      unsubscribe = onSnapshot(
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

      if (context) {
        logger.debug('tenantService.listenToJoinRequests reattached', { context, tenantId });
      }
    };

    attach('initial');
    const unregister = getAuthService().registerFirestoreReinit?.(() => attach('reinit'));

    return () => {
      disposed = true;
      unsubscribe?.();
      try {
        unregister?.();
      } catch {}
    };
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
    // Server-mediated (security-rules-hardening C1): the backend enforces the
    // active-code cap, generates the code, and writes the audit entry.
    try {
      const response = await tenantBackendClient.createTenantCode({
        tenantId: params.tenantId,
        expiresInDays: params.expiresInDays,
        usageCap: params.usageCap,
      });
      return response.code as TenantCode;
    } catch (error) {
      logger.error('tenantService.createTenantCode failed', error);
      if (error instanceof TenantBackendError) {
        throw new Error(error.message);
      }
      throw new Error('Failed to create join code');
    }
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

  async revokeCode(tenantId: string, codeId: string, _actorId: string): Promise<void> {
    // Server-mediated (security-rules-hardening C1): the backend verifies the
    // code belongs to the tenant, flips it to revoked, and writes the audit entry.
    try {
      await tenantBackendClient.revokeTenantCode({ tenantId, codeId });
    } catch (error) {
      logger.error('tenantService.revokeCode failed', error);
      if (error instanceof TenantBackendError) {
        throw new Error(error.message);
      }
      throw new Error('Failed to revoke join code');
    }
  }

  async expireStaleJoinCodes(tenantId: string): Promise<{ expired: number }> {
    const now = new Date().toISOString();
    const q = query(
      this.codeRef,
      where('tenantId', '==', tenantId),
      where('status', '==', 'active'),
    );
    const snapshot = await getDocs(q);
    const expiredDocs = snapshot.docs.filter((docSnap) => {
      const data = docSnap.data() as TenantCode;
      if (!data.expiresAt) return false;
      const expiresMs = Date.parse(data.expiresAt);
      return !Number.isNaN(expiresMs) && expiresMs <= Date.now();
    });
    if (expiredDocs.length === 0) {
      return { expired: 0 };
    }
    await Promise.all(
      expiredDocs.map((docSnap) =>
        updateDoc(docSnap.ref, { status: 'expired', updatedAt: now }).catch((err) =>
          logger.warn('tenantService.expireStaleJoinCodes: updateDoc failed', err),
        ),
      ),
    );
    logger.info(`tenantService.expireStaleJoinCodes: expired ${expiredDocs.length} codes for tenant ${tenantId}`);
    return { expired: expiredDocs.length };
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
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    const attach = (context?: string) => {
      if (disposed) return;
      unsubscribe?.();
      unsubscribe = onSnapshot(
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

      if (context) {
        logger.debug('tenantService.listenToInvites reattached', { context, tenantId });
      }
    };

    attach('initial');
    const unregister = getAuthService().registerFirestoreReinit?.(() => attach('reinit'));

    return () => {
      disposed = true;
      unsubscribe?.();
      try {
        unregister?.();
      } catch {}
    };
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
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    const attach = (context?: string) => {
      if (disposed) return;
      unsubscribe?.();
      unsubscribe = onSnapshot(
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

      if (context) {
        logger.debug('tenantService.listenToIncomingInvites reattached', { context, normalizedEmail });
      }
    };

    attach('initial');
    const unregister = getAuthService().registerFirestoreReinit?.(() => attach('reinit'));

    return () => {
      disposed = true;
      unsubscribe?.();
      try {
        unregister?.();
      } catch {}
    };
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
    // Server-mediated (security-rules-hardening C1): mirroring invites into
    // `tenantMemberships/{tenantId}_{uid}` placeholder docs is now done by the
    // backend, which derives uid + email from the auth token and queries the
    // caller's invites itself. The client only forwards a display name for the
    // rejected-event actor label. `userId`/`email`/`invites` are ignored here
    // (kept in the signature for call-site compatibility).
    const email = (params.email || '').trim().toLowerCase();
    if (!email) {
      return;
    }
    try {
      await tenantBackendClient.syncInviteMemberships({ displayName: params.displayName });
    } catch (error) {
      // Best-effort sync; never surface as a hard error to the UI.
      logger.debug('tenantService.syncIncomingInvitesToMembershipsForUser failed', error);
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
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    const attach = (context?: string) => {
      if (disposed) return;
      unsubscribe?.();
      unsubscribe = onSnapshot(
        q,
        (snapshot) => {
          const now = Date.now();

          const codes = snapshot.docs.map((docSnap) => {
            const data = { id: docSnap.id, ...docSnap.data() } as TenantCode;
            // Present expired-but-not-yet-flipped codes correctly in the UI.
            // The DB flip is performed server-side (the backend self-heals stale
            // 'active' codes when enforcing the active-code cap); the client no
            // longer writes to `tenantCodes` (locked to backend-only writes).
            if (data.status === 'active' && data.expiresAt) {
              const expiresMs = Date.parse(data.expiresAt);
              if (!Number.isNaN(expiresMs) && expiresMs <= now) {
                return { ...data, status: 'expired' as const };
              }
            }
            return data;
          });

          onSuccess(codes);
        },
        (error) => {
          logger.error('tenantService.listenToCodes failed', error);
          onError?.(error as Error);
        },
      );

      if (context) {
        logger.debug('tenantService.listenToCodes reattached', { context, tenantId });
      }
    };

    attach('initial');
    const unregister = getAuthService().registerFirestoreReinit?.(() => attach('reinit'));

    return () => {
      disposed = true;
      unsubscribe?.();
      try {
        unregister?.();
      } catch {}
    };
  }

  async logAuditEvent(entry: Omit<TenantAuditLogEntry, 'id' | 'createdAt'>): Promise<void> {
    // Server-mediated (security-rules-hardening C1): `tenantAuditLogs` is
    // backend-only. Activity audit entries (attendance/fee actions) are appended
    // via the backend, which stamps the actor from the verified token. Other
    // audit actions are already written server-side by their own endpoints.
    const tenantId = (entry.tenantId || '').trim();
    if (!tenantId) {
      return;
    }
    try {
      await tenantBackendClient.logActivityAudit({
        tenantId,
        action: entry.action,
        targetId: entry.targetId,
        targetType: entry.targetType as 'fee' | 'attendance' | undefined,
        metadata: entry.metadata,
      });
    } catch (error) {
      // Audit logging is best-effort and must never block the underlying action.
      logger.debug('tenantService.logAuditEvent failed', error);
    }
  }
}

export const tenantService = new TenantService();
