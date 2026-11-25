import type { TenantMembershipRole } from './tenant';
import type { NoticeSource } from '../lib/noticeIndexFields';

export interface Notice {
  id: string;
  tenantId?: string | null;
  targetTenantRoles?: TenantMembershipRole[];
  createdByRole?: TenantMembershipRole | 'system' | null;
  title: string;
  content: string;
  imageUrl?: string;
  audioUrl?: string;
  audioFileName?: string;
  audioFileSize?: number;
  audioDurationMs?: number;
  audioStoragePath?: string;
  linkUrl?: string;
  linkTitle?: string;
  priority: 'low' | 'medium' | 'high';
  createdAt: string;
  createdBy: string;
  createdByName: string;
  createdByEmail: string; // Added to determine role in real-time
  updatedAt?: string;
  isActive: boolean;
  targetAudience: string[]; // Changed to array to support multiple selections
  viewCount: number;
  userViews: { [userId: string]: { count: number; lastViewed: string } };

  // Reactions are stored as { [reactionType]: [userId, ...] }
  // Counts are derived from the array lengths.
  reactions?: Record<string, string[]>;
  /** Total reactions (sum of the `reactions` arrays), kept in sync on toggle. */
  reactionCount?: number;

  // Denormalized query fields (schemaVersion 2, see lib/noticeIndexFields.ts).
  // Optional here because v1 docs written before the backfill lack them.
  visibleToRoles?: TenantMembershipRole[];
  roleRestricted?: boolean;
  hasImage?: boolean;
  hasAudio?: boolean;
  hasLink?: boolean;
  source?: NoticeSource;
  schemaVersion?: number;
}

export interface NoticeFormData {
  title: string;
  content: string;
  tenantId?: string;
  targetTenantRoles?: TenantMembershipRole[];
  createdByRole?: TenantMembershipRole | 'system' | null;
  imageUrl?: string;
  audioUrl?: string;
  audioFileName?: string;
  audioFileSize?: number;
  audioDurationMs?: number;
  audioStoragePath?: string;
  linkUrl?: string;
  linkTitle?: string;
  priority: 'low' | 'medium' | 'high';
  targetAudience: string[]; // Changed to array to support multiple selections
}
