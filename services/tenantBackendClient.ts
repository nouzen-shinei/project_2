import { logger } from '@/lib/logger';
import type { TenantMembershipRole, TenantNotificationPreferences } from '@/types';
import { internalTokenManager } from './internalTokenManager';
import { maybeEmitBillingPastDueFromParsed } from '@/lib/billingPastDue';
import { runtimeEndpoints } from './runtimeEndpoints';
import { maybeShowMaintenanceAlertFromRaw } from './maintenanceAlert';

export interface TenantJoinCodeTenant {
  id: string;
  name: string;
  slug?: string;
  status?: string;
  logoUrl?: string | null;
  heroImageUrl?: string | null;
  theme?: Record<string, unknown> | null;
  branding?: Record<string, unknown> | undefined;
  settings?: Record<string, unknown> | undefined;
  defaultCurrency?: string;
  timezone?: string;
}

export interface TenantJoinCodeMetadata {
  id: string;
  status: string;
  createdAt: string | null;
  expiresAt: string | null;
  lastUsedAt?: string | null;
  usageCount: number;
  usageCap?: number | null;
}

export interface TenantJoinMembershipPreview {
  id: string;
  email?: string;
  role?: string;
  status?: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TenantJoinRequestPreview {
  id: string;
  status: string;
  requestedAt: string | null;
  reviewedAt: string | null;
  message?: string | null;
  expiresAt?: string | null;
}

export interface TenantJoinCodePreviewResponse {
  tenant: TenantJoinCodeTenant;
  code: TenantJoinCodeMetadata;
  membership: TenantJoinMembershipPreview | null;
  pendingInvite?: boolean;
}

export interface TenantJoinCodeClaimResponse {
  ok: boolean;
  alreadyMember?: boolean;
  pendingRequest?: boolean;
  tenant: TenantJoinCodeTenant;
  membership: TenantJoinMembershipPreview;
  joinRequest?: TenantJoinRequestPreview;
  code: Partial<TenantJoinCodeMetadata> & { id: string };
}

export type TenantNotificationPreferenceKey = keyof TenantNotificationPreferences;

export interface TenantNotificationPreferenceUpdateResponse {
  ok: boolean;
  notificationPreferences: TenantNotificationPreferences;
  changedKeys: TenantNotificationPreferenceKey[];
}

export class TenantBackendError extends Error {
  code: string;

  constructor(code: string, message?: string) {
    super(message || code);
    this.code = code;
  }
}

class TenantBackendClient {
  private readonly debug = process.env.EXPO_PUBLIC_DEBUG_AUTH === '1' || process.env.EXPO_PUBLIC_DEBUG_AUTH === 'true';

  constructor() {
    const base = runtimeEndpoints.getPreferredBackendBaseUrl();
    if (base) internalTokenManager.setBaseUrl(base);
  }

  private ensureBaseUrl(): string {
    const baseUrl = runtimeEndpoints.getPreferredBackendBaseUrl();
    if (!baseUrl) {
      throw new TenantBackendError(
        'backend_unavailable',
        'Backend API base URL missing. Configure Firestore appSettings/runtimeEndpoints.apiBaseUrl to enable join codes.',
      );
    }
    return baseUrl;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const baseUrl = runtimeEndpoints.getPreferredBackendBaseUrl();
    if (!baseUrl) return headers;
    const token = await internalTokenManager.getToken(baseUrl);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  private describeError(code: string): string {
    switch (code) {
      case 'code_not_found':
        return 'No coaching center found for that join code.';
      case 'code_revoked':
        return 'This join code has been revoked by the coaching center.';
      case 'code_expired':
        return 'This join code has expired. Ask the coaching center for a fresh code.';
      case 'tenant_unavailable':
        return 'This coaching center is currently unavailable for new members.';
      case 'tenant_not_found':
        return 'The coaching center linked to this code no longer exists.';
      case 'code_limit_reached':
        return 'That join code has already been used the maximum number of times.';
      case 'email_required':
        return 'Sign in again to claim this code (email missing).';
      case 'invalid_code':
        return 'Please enter a valid join code.';
      case 'lookup_failed':
        return 'Unable to look up this join code right now. Please try again.';
      case 'claim_failed':
        return 'Unable to claim this join code right now. Please try again.';
      case 'owner_role_required':
        return 'Only owners can assign the owner role.';
      case 'seat_limit_reached':
        return 'All team seats are in use (including pending invites). Remove a member, revoke a pending invite, or upgrade your plan to continue.';
      case 'invite_not_found':
        return 'This invite is no longer available.';
      case 'invite_revoked':
        return 'This invite was revoked by the coaching center.';
      case 'invite_expired':
        return 'This invite has expired. Ask the coaching center for a fresh link.';
      case 'invite_already_used':
        return 'This invite link was already used.';
      case 'invite_rejected':
        return 'You already rejected this invite. Ask the coaching center for a fresh link if you changed your mind.';
      case 'invite_not_pending':
        return 'Only pending invites can be resent or revoked.';
      case 'invite_email_mismatch':
        return 'Sign in with the email that originally received this invite.';
      case 'invite_accept_failed':
        return 'Unable to accept this invite right now. Please try again in a moment.';
      case 'invite_pending':
        return 'You already have a pending invite for this coaching center. Please accept the invite instead of using a join code.';
      case 'already_member':
        return 'This account is already a member of that coaching center.';
      case 'join_request_pending':
        return 'You already have a pending join request for that coaching center.';
      case 'request_not_found':
        return 'That join request no longer exists.';
      case 'request_already_reviewed':
        return 'This join request has already been reviewed.';
      case 'tenant_mismatch':
        return 'You can only manage requests for the active coaching center.';
      default:
        return 'Unexpected error while contacting the coaching center backend.';
    }
  }

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const baseUrl = this.ensureBaseUrl();
    let headers = await this.buildHeaders();
    let response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (response.status === 401) {
      await internalTokenManager.forceRefresh(baseUrl);
      headers = await this.buildHeaders();
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    }

    const raw = await response.text();
    maybeShowMaintenanceAlertFromRaw(response.status, raw);
    let parsed: any = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        if (this.debug) {
          logger.debug('[tenant-backend] Non-JSON response', raw.slice(0, 200));
        }
      }
    }

    if (!response.ok) {
      const code = typeof parsed?.error === 'string' ? parsed.error : `http_${response.status}`;

      // Grace-period enforcement (server) surfaces as HTTP 402.
      maybeEmitBillingPastDueFromParsed(response.status, parsed);

      const message = this.describeError(code);
      throw new TenantBackendError(code, message);
    }

    return parsed as T;
  }

  resolveJoinCode(code: string): Promise<TenantJoinCodePreviewResponse> {
    return this.request('/tenants/join-code/resolve', { code });
  }

  claimJoinCode(payload: { code: string; displayName?: string; message?: string }): Promise<TenantJoinCodeClaimResponse> {
    return this.request('/tenants/join-code/claim', payload);
  }

  notifyJoinRequestSubmitted(payload: { tenantId: string; requestId: string }): Promise<void> {
    return this.request<void>('/notifications/tenant-join-request', payload);
  }

  notifyJoinRequestOutcome(payload: {
    tenantId: string;
    requestId: string;
    outcome: 'approved' | 'rejected';
    assignedRole?: TenantMembershipRole;
    reviewerName?: string;
  }): Promise<void> {
    return this.request<void>('/notifications/tenant-join-request/outcome', payload);
  }

  notifyTenantInvite(payload: { tenantId: string; inviteId: string }): Promise<void> {
    return this.request<void>('/notifications/tenant-invite', payload);
  }

  approveJoinRequest(payload: {
    tenantId: string;
    requestId: string;
    role: TenantMembershipRole;
    reviewerName?: string;
    metadata?: {
      reason?: string;
      initiatedFrom?: 'web' | 'mobile' | 'system';
      actorName?: string;
    };
  }): Promise<{ ok: boolean }> {
    const tenantId = payload.tenantId?.trim();
    const requestId = payload.requestId?.trim();
    if (!tenantId || !requestId) {
      throw new TenantBackendError('tenant_required', 'Tenant and request ids are required');
    }
    const path = `/tenants/${encodeURIComponent(tenantId)}/join-requests/${encodeURIComponent(requestId)}/approve`;
    return this.request<{ ok: boolean }>(path, {
      role: payload.role,
      reviewerName: payload.reviewerName,
      metadata: payload.metadata,
    });
  }

  rejectJoinRequest(payload: {
    tenantId: string;
    requestId: string;
    reviewerName?: string;
    reason?: string;
    metadata?: {
      reason?: string;
      initiatedFrom?: 'web' | 'mobile' | 'system';
      actorName?: string;
    };
  }): Promise<{ ok: boolean }> {
    const tenantId = payload.tenantId?.trim();
    const requestId = payload.requestId?.trim();
    if (!tenantId || !requestId) {
      throw new TenantBackendError('tenant_required', 'Tenant and request ids are required');
    }
    const path = `/tenants/${encodeURIComponent(tenantId)}/join-requests/${encodeURIComponent(requestId)}/reject`;
    return this.request<{ ok: boolean }>(path, {
      reviewerName: payload.reviewerName,
      metadata: payload.metadata,
      reason: payload.reason,
    });
  }

  createInvite(payload: {
    tenantId: string;
    email: string;
    role: TenantMembershipRole;
    expiresInDays?: number;
    message?: string;
  }): Promise<{ ok: boolean; invite: any }> {
    const tenantId = payload.tenantId?.trim();
    if (!tenantId) {
      throw new TenantBackendError('tenant_required', 'Tenant id is required');
    }
    const path = `/tenants/${encodeURIComponent(tenantId)}/invites`;
    return this.request(path, {
      email: payload.email,
      role: payload.role,
      expiresInDays: payload.expiresInDays,
      message: payload.message,
    });
  }

  resendInvite(payload: { tenantId: string; inviteId: string }): Promise<{ ok: boolean; invite: any }> {
    const tenantId = payload.tenantId?.trim();
    const inviteId = payload.inviteId?.trim();
    if (!tenantId || !inviteId) {
      throw new TenantBackendError('tenant_required', 'Tenant and invite ids are required');
    }
    const path = `/tenants/${encodeURIComponent(tenantId)}/invites/${encodeURIComponent(inviteId)}/resend`;
    return this.request(path, {});
  }

  revokeInvite(payload: { tenantId: string; inviteId: string }): Promise<{ ok: boolean; invite: any }> {
    const tenantId = payload.tenantId?.trim();
    const inviteId = payload.inviteId?.trim();
    if (!tenantId || !inviteId) {
      throw new TenantBackendError('tenant_required', 'Tenant and invite ids are required');
    }
    const path = `/tenants/${encodeURIComponent(tenantId)}/invites/${encodeURIComponent(inviteId)}/revoke`;
    return this.request(path, {});
  }

  acceptInvite(payload: { token: string }): Promise<{ ok: boolean }> {
    const token = payload.token?.trim();
    if (!token) {
      throw new TenantBackendError('invite_token_required', 'Invite link missing or invalid.');
    }
    return this.request('/tenants/invites/accept', { token });
  }

  rejectInvite(payload: { token: string }): Promise<{ ok: boolean }> {
    const token = payload.token?.trim();
    if (!token) {
      throw new TenantBackendError('invite_token_required', 'Invite link missing or invalid.');
    }
    return this.request('/tenants/invites/reject', { token });
  }

  updateMembershipRole(payload: {
    tenantId: string;
    userId: string;
    role: TenantMembershipRole;
    metadata?: {
      reason?: string;
      initiatedFrom?: 'web' | 'mobile' | 'system';
      actorName?: string;
    };
  }): Promise<{ ok: boolean }> {
    const tenantId = payload.tenantId?.trim();
    const userId = payload.userId?.trim();
    if (!tenantId || !userId) {
      throw new TenantBackendError('tenant_required', 'Tenant and user ids are required');
    }
    const path = `/tenants/${encodeURIComponent(tenantId)}/memberships/${encodeURIComponent(userId)}/role`;
    return this.request<{ ok: boolean }>(path, {
      role: payload.role,
      metadata: payload.metadata,
    });
  }

  updateMembershipStatus(payload: {
    tenantId: string;
    userId: string;
    status: 'active' | 'pending_request' | 'revoked' | 'rejected';
    metadata?: {
      reason?: string;
      initiatedFrom?: 'web' | 'mobile' | 'system';
      actorName?: string;
    };
  }): Promise<{ ok: boolean }> {
    const tenantId = payload.tenantId?.trim();
    const userId = payload.userId?.trim();
    if (!tenantId || !userId) {
      throw new TenantBackendError('tenant_required', 'Tenant and user ids are required');
    }
    const path = `/tenants/${encodeURIComponent(tenantId)}/memberships/${encodeURIComponent(userId)}/status`;
    return this.request<{ ok: boolean }>(path, {
      status: payload.status,
      metadata: payload.metadata,
    });
  }

  updateTenantNotificationPreferences(payload: {
    tenantId: string;
    notificationPreferences: Partial<TenantNotificationPreferences>;
    metadata?: {
      initiatedFrom?: string;
      actorName?: string;
      reason?: string;
    };
  }): Promise<TenantNotificationPreferenceUpdateResponse> {
    const tenantId = payload.tenantId?.trim();
    if (!tenantId) {
      throw new TenantBackendError('tenant_required', 'Tenant id is required');
    }
    const path = `/tenants/${encodeURIComponent(tenantId)}/preferences`;
    return this.request<TenantNotificationPreferenceUpdateResponse>(path, {
      notificationPreferences: payload.notificationPreferences,
      metadata: payload.metadata,
    });
  }
}

export const tenantBackendClient = new TenantBackendClient();
