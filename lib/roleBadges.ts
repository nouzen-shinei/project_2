import type { TenantMembershipRole } from '@/types';

export type RoleBadgeConfig = {
  label: string;
  displayLabel: string;
  backgroundColor: string;
  textColor: string;
  initial: string;
  accessLabel: string;
};

// Keep these values in sync with Settings UI so role badges are consistent across the app.
export const ROLE_BADGE_MAP: Record<TenantMembershipRole, RoleBadgeConfig> = {
  owner: {
    label: 'OWNER',
    displayLabel: 'Owner',
    backgroundColor: '#7C3AED',
    textColor: '#ffffff',
    initial: 'O',
    accessLabel: 'Owner Access',
  },
  admin: {
    label: 'ADMIN',
    displayLabel: 'Admin',
    backgroundColor: '#FFD700',
    textColor: '#000000',
    initial: 'A',
    accessLabel: 'Admin Access',
  },
  staff: {
    label: 'STAFF',
    displayLabel: 'Staff',
    backgroundColor: '#0E9F6E',
    textColor: '#ffffff',
    initial: 'S',
    accessLabel: 'Staff Access',
  },
  member: {
    label: 'MEMBER',
    displayLabel: 'Member',
    backgroundColor: '#2563EB',
    textColor: '#ffffff',
    initial: 'M',
    accessLabel: 'Member Access',
  },
};

export function getRoleBadgeConfig(role?: string | null): RoleBadgeConfig | null {
  if (!role) {
    return null;
  }
  return (ROLE_BADGE_MAP as Record<string, RoleBadgeConfig | undefined>)[role] ?? null;
}
