/**
 * Roster merging helpers - combines team roster with presence and profile hydration
 * 
 * Pure deterministic logic for merging team member roster data with real-time
 * presence information and cached profile data to create a complete team member view.
 * 
 * Uses flexible input types to handle various TeamMember shapes across the codebase.
 */

export interface RosterMergeInput {
  roster?: any[] | null;
  presenceMap?: Map<string, any> | null;
  profileMap?: Map<string, any> | null;
}

/**
 * Merges a team member roster with presence and profile snapshot data.
 * 
 * For each member in the roster:
 * 1. Looks up presence info by normalized email or ID
 * 2. Looks up profile info by normalized email or ID
 * 3. Merges data with priority: profile > presence > original
 * 4. Preserves original tenant role without overwrite
 * 
 * Returns roster with hydrated presence/profile fields, or empty array if input is empty.
 */
export function resolveChatRosterMergedWithPresence(
  input?: RosterMergeInput
): any[] {
  const { roster, presenceMap, profileMap } = input || {};

  if (!roster || roster.length === 0) {
    return [];
  }

  return roster.map((member: any) => {
    // Normalize the member key for presence/profile lookup
    const lookupKey = normalizeTeamMemberLookupKey(member);

    if (!lookupKey) {
      // If lookup key is empty, return member as-is
      return member;
    }

    const presence = presenceMap?.get(lookupKey);
    const profile = profileMap?.get(lookupKey);

    // If no presence or profile data, return original member
    if (!presence && !profile) {
      return member;
    }

    // Merge with priority: profile > presence > original
    return {
      ...member,
      role: member.role, // Preserve tenant role
      tenantRole: member.tenantRole,
      name: profile?.name || presence?.name || member.name,
      avatar: profile?.avatar || presence?.avatar || member.avatar,
      photoURL: profile?.photoURL ?? presence?.photoURL ?? member.photoURL,
      customImageURL:
        profile?.customImageURL ?? presence?.customImageURL ?? member.customImageURL,
      isOnline: presence?.isOnline ?? member.isOnline,
      lastSeen: presence?.lastSeen ?? member.lastSeen,
      typingTo: presence?.typingTo ?? member.typingTo,
      school: profile?.school ?? member.school,
      bio: profile?.bio ?? member.bio,
      phone: profile?.phone ?? member.phone,
      dateOfBirth: profile?.dateOfBirth ?? member.dateOfBirth,
      salutation: profile?.salutation ?? member.salutation,
      subjects: profile?.subjects ?? member.subjects,
    };
  });
}

/**
 * Normalizes a team member lookup key for presence/profile map matching.
 * 
 * Uses lowercase email if available, falls back to ID.
 * Returns empty string if both are missing or invalid.
 */
export function normalizeTeamMemberLookupKey(member?: any): string {
  if (!member) {
    return '';
  }

  // Prefer normalized email
  if (member.email && typeof member.email === 'string') {
    const normalized = member.email.toLowerCase();
    if (normalized) {
      return normalized;
    }
  }

  // Fall back to ID
  if (member.id) {
    return String(member.id);
  }

  return '';
}

/**
 * Type helper: checks if a team member has complete presence metadata.
 * 
 * Used to determine if a member snapshot contains real-time presence fields.
 */
export function isChatTeamMemberPresenceHydrated(member?: any): boolean {
  if (!member) return false;

  // Check for at least one presence-specific field
  return (
    member.isOnline !== undefined ||
    member.lastSeen !== undefined ||
    member.typingTo !== undefined
  );
}

/**
 * Type helper: checks if a team member has profile metadata.
 * 
 * Used to determine if a member snapshot contains cached profile fields.
 */
export function isChatTeamMemberProfileHydrated(member?: any): boolean {
  if (!member) return false;

  // Check for at least one profile-specific field
  return member.bio !== undefined || member.phone !== undefined;
}
