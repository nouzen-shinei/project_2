import type { TenantMembershipRole } from '../types/tenant';

/**
 * Denormalized "index" fields stored on every `notices/{id}` document so the
 * notice list, filter chips, counts and security rules can be answered by
 * Firestore queries instead of downloading every notice.
 *
 * Keep in sync with `backend-runtime/src/lib/noticeIndexFields.ts` (backend
 * writers + backfill script use that copy; the app bundle can't import it).
 *
 * Schema history:
 *   1 — original fields (title, content, targetTenantRoles, imageUrl, ...).
 *   2 — adds the fields below. Docs without `schemaVersion` are v1 and are
 *       upgraded by `scripts/backfillNoticeIndexFields.ts`.
 */
export const NOTICE_SCHEMA_VERSION = 2;

/** Every tenant role, in canonical order. */
export const ALL_NOTICE_ROLES: readonly TenantMembershipRole[] = ['owner', 'admin', 'staff', 'member'];

/** Roles that see an "Admins only" notice. */
export const ADMIN_NOTICE_ROLES: readonly TenantMembershipRole[] = ['owner', 'admin'];

/**
 * Who created the notice. `user` = posted from the app; the others are
 * written by the backend. Lets future features hide or group automatic
 * notices, and keeps them out of the "notice posts" usage statistic.
 */
export type NoticeSource = 'user' | 'usage_monitor' | 'billing' | 'system';

export type NoticeIndexFields = {
  /** Roles allowed to see the notice. Always non-empty. Queried with array-contains. */
  visibleToRoles: TenantMembershipRole[];
  /** True when `targetTenantRoles` limits the audience ("Admins only"). */
  roleRestricted: boolean;
  hasImage: boolean;
  hasAudio: boolean;
  hasLink: boolean;
  source: NoticeSource;
  schemaVersion: number;
};

const isNonEmptyString = (value: unknown): boolean =>
  typeof value === 'string' && value.trim().length > 0;

/** Valid, de-duplicated roles in canonical order; [] when unrestricted. */
export const normalizeTargetTenantRoles = (value: unknown): TenantMembershipRole[] => {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.filter((role): role is string => typeof role === 'string'));
  return ALL_NOTICE_ROLES.filter((role) => wanted.has(role));
};

export const deriveNoticeIndexFields = (notice: {
  targetTenantRoles?: unknown;
  imageUrl?: unknown;
  audioUrl?: unknown;
  linkUrl?: unknown;
  source: NoticeSource;
}): NoticeIndexFields => {
  const restrictedTo = normalizeTargetTenantRoles(notice.targetTenantRoles);
  return {
    visibleToRoles: restrictedTo.length > 0 ? restrictedTo : [...ALL_NOTICE_ROLES],
    roleRestricted: restrictedTo.length > 0,
    hasImage: isNonEmptyString(notice.imageUrl),
    hasAudio: isNonEmptyString(notice.audioUrl),
    hasLink: isNonEmptyString(notice.linkUrl),
    source: notice.source,
    schemaVersion: NOTICE_SCHEMA_VERSION,
  };
};

/** Total reactions across all reaction types (one per user). */
export const countNoticeReactions = (reactions: unknown): number => {
  if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) return 0;
  return Object.values(reactions as Record<string, unknown>).reduce<number>(
    (sum, users) => sum + (Array.isArray(users) ? users.length : 0),
    0,
  );
};
