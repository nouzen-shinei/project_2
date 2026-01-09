import type { TenantMembershipRole } from './tenant';

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
