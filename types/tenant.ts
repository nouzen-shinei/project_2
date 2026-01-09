import type { Timestamp } from 'firebase/firestore';

export type TenantStatus = 'active' | 'suspended' | 'archived';
export type TenantBillingTier = 'free' | 'pro' | 'enterprise';
export type TenantMembershipRole = 'owner' | 'admin' | 'staff' | 'member';
export type TenantMembershipStatus = 'active' | 'pending_invite' | 'pending_request' | 'revoked' | 'rejected';
export type TenantInviteStatus = 'pending' | 'accepted' | 'expired' | 'revoked';
export type TenantJoinRequestStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type TenantChecklistItemId = 'profile-basics' | 'branding' | 'team' | 'join-codes' | 'notifications';

export interface TenantMembershipStatusEvent {
  status: TenantMembershipStatus;
  at: string;
  actorId?: string;
  actorEmail?: string;
  actorName?: string;
  reason?: string;
}

export interface TenantTheme {
  primary: string;
  accent?: string;
  background?: string;
  surface?: string;
  text?: string;
}

export interface TenantBranding {
  logoUrl?: string | null;
  heroImageUrl?: string | null;
  accentImageUrl?: string | null;
  tagline?: string | null;
  missionStatement?: string | null;
}

export interface TenantOnboardingProgress {
  dismissedChecklistItems?: TenantChecklistItemId[];
  lastReviewedAt?: string;
}

export interface TenantQuota {
  // Quotas are manual overrides. When null/undefined, the effective plan limits apply.
  maxStudents: number | null;
  maxStaff: number | null;
  maxMonthlyReminders: number | null;
  maxStorageMb: number | null;
}

export interface TenantSettings {
  allowJoinRequests: boolean;
  notifyOnJoinRequest: boolean;
  notifyViaEmail: boolean;
  inviteExpiryDaysDefault: number;
}

export interface TenantNotificationPreferences {
  membershipEventsEmail: boolean;
  membershipEventsPush: boolean;
  joinRequestEmail: boolean;
  joinRequestPush: boolean;
  usageAlertEmail: boolean;
  usageAlertWhatsApp: boolean;
  usageAlertSlack: boolean;
}

export interface TenantMembershipCounts {
  total: number;
  active: number;
  pending: number;
  owners: number;
  admins: number;
  staff: number;
}

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  code: string;
  ownerUserId: string;
  ownerEmail: string;
  address?: string;
  timezone?: string;
  defaultCurrency?: string;
  contactEmail?: string;
  contactPhone?: string;
  logoUrl?: string | null; // legacy field, prefer branding.logoUrl
  heroImageUrl?: string | null; // legacy field, prefer branding.heroImageUrl
  branding?: TenantBranding;
  status: TenantStatus;
  billingTier: TenantBillingTier;
  quotas: TenantQuota;
  theme?: TenantTheme;
  settings: TenantSettings;
  onboardingProgress?: TenantOnboardingProgress;
  notificationPreferences?: TenantNotificationPreferences;
  membershipCounts?: TenantMembershipCounts;
  createdAt: string;
  updatedAt: string;
}

export interface TenantMembership {
  id: string;
  tenantId: string;
  userId: string;
  email: string;
  displayName?: string;
  role: TenantMembershipRole;
  status: TenantMembershipStatus;
  inviteToken?: string;
  inviteExpiresAt?: string | Timestamp;
  invitedBy?: string;
  approvedBy?: string;
  createdAt: string;
  updatedAt: string;
  statusHistory?: TenantMembershipStatusEvent[];
}

export interface TenantInviteAudit {
  id: string;
  tenantId: string;
  email: string;
  issuedBy: string;
  issuedAt: string;
  expiresAt: string;
  status: 'active' | 'accepted' | 'expired' | 'revoked';
  metadata?: Record<string, unknown>;
}

export interface TenantJoinRequest {
  id: string;
  tenantId: string;
  tenantName?: string;
  userId: string;
  email: string;
  displayName?: string;
  message?: string;
  status: TenantJoinRequestStatus;
  requestedAt: string;
  expiresAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  joinCodeId?: string;
  joinCodeValue?: string;
  joinCodeStatusSnapshot?: string;
  joinCodeUsageCap?: number | null;
  joinCodeUsageCount?: number;
  lastUpdatedAt?: string;
}

export interface TenantCode {
  id: string;
  tenantId: string;
  code: string;
  createdBy: string;
  createdAt: string;
  expiresAt?: string;
  usageCount: number;
  usageCap?: number | null;
  lastUsedAt?: string;
  status: 'active' | 'revoked' | 'expired';
}

export interface TenantInvite {
  id: string;
  tenantId: string;
  email: string;
  role: TenantMembershipRole;
  status: TenantInviteStatus;
  token: string;
  issuedBy: string;
  issuedAt: string;
  expiresAt: string;
  acceptedAt?: string;
  acceptedBy?: string;
  lastSentAt?: string;
  lastSentBy?: string;
  invitationMessage?: string;
}

export interface TenantAuditLogEntry {
  id: string;
  tenantId: string;
  actorId: string;
  actorEmail?: string;
  action:
    | 'tenant_created'
    | 'tenant_updated'
    | 'membership_invited'
    | 'membership_revoked'
    | 'membership_role_changed'
    | 'membership_status_changed'
    | 'join_request_submitted'
    | 'join_request_reviewed'
    | 'invite_regenerated'
    | 'quota_override'
    | 'reminder_queued'
    | 'fee_record_created'
    | 'fee_record_updated'
    | 'fee_record_deleted'
    | 'fee_payment_updated'
    | 'fee_due_dates_updated'
    | 'attendance_record_saved'
    | 'attendance_records_batch_saved'
    | 'attendance_record_deleted';
  targetId?: string;
  targetType?: 'tenant' | 'membership' | 'invite' | 'joinRequest' | 'quota' | 'code' | 'reminder' | 'fee' | 'attendance';
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface TenantUsageSnapshot {
  id: string;
  tenantId: string;
  period: string; // e.g. 2025-11
  students: number;
  staff: number;
  remindersSent: number;
  storageMb: number;
  updatedAt: string;
}
