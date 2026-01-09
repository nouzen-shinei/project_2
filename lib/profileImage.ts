// Centralized helper to determine the best profile image URL for a team member.
// Business rule: Settings promotes photoURL as the active image, and customImageURL is a backup.
// Priority: photoURL (active) > customImageURL (backup) > fallback to empty string

import type { TeamMember } from '../hooks/useAuthUnified';

export function getProfileImageUrl(member?: TeamMember | null): string {
  if (!member) return '';
  return member.photoURL || member.customImageURL || '';
}
