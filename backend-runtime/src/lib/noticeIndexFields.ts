/**
 * Denormalized "index" fields stored on every `notices/{id}` document so the
 * app's notice list, filter chips, counts and the Firestore security rules can
 * be answered by queries instead of downloading every notice.
 *
 * Keep in sync with the app copy at `lib/noticeIndexFields.ts` (the app bundle
 * can't import backend sources). Used by the backend notice writers and by
 * `scripts/backfillNoticeIndexFields.ts`.
 *
 * Schema history:
 *   1 — original fields (title, content, targetTenantRoles, imageUrl, ...).
 *   2 — adds visibleToRoles, roleRestricted, hasImage, hasAudio, hasLink,
 *       source, schemaVersion, reactionCount. Usage Monitor notices become
 *       admins-only (targetTenantRoles = owner + admin).
 */
export const NOTICE_SCHEMA_VERSION = 2;

export const ALL_NOTICE_ROLES = ['owner', 'admin', 'staff', 'member'] as const;
export type NoticeRole = (typeof ALL_NOTICE_ROLES)[number];

/** Roles that see an "Admins only" notice. */
export const ADMIN_NOTICE_ROLES: readonly NoticeRole[] = ['owner', 'admin'];

/** `user` = posted from the app; the rest are written by the backend. */
export type NoticeSource = 'user' | 'usage_monitor' | 'billing' | 'system';
const NOTICE_SOURCES: readonly NoticeSource[] = ['user', 'usage_monitor', 'billing', 'system'];

export type NoticeIndexFields = {
  visibleToRoles: NoticeRole[];
  roleRestricted: boolean;
  hasImage: boolean;
  hasAudio: boolean;
  hasLink: boolean;
  source: NoticeSource;
  schemaVersion: number;
};

const isNonEmptyString = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

/** Valid, de-duplicated roles in canonical order; [] when unrestricted. */
export function normalizeTargetTenantRoles(value: unknown): NoticeRole[] {
  if (!Array.isArray(value)) return [];
  const wanted = new Set(value.filter((role): role is string => typeof role === 'string'));
  return ALL_NOTICE_ROLES.filter((role) => wanted.has(role));
}

export function deriveNoticeIndexFields(notice: {
  targetTenantRoles?: unknown;
  imageUrl?: unknown;
  audioUrl?: unknown;
  linkUrl?: unknown;
  source: NoticeSource;
}): NoticeIndexFields {
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
}

/** Total reactions across all reaction types (one per user). */
export function countNoticeReactions(reactions: unknown): number {
  if (!reactions || typeof reactions !== 'object' || Array.isArray(reactions)) return 0;
  return Object.values(reactions as Record<string, unknown>).reduce<number>(
    (sum, users) => sum + (Array.isArray(users) ? users.length : 0),
    0,
  );
}

/** Works out who wrote a notice, for docs written before `source` existed. */
export function inferNoticeSource(data: Record<string, unknown>, docId: string): NoticeSource {
  const existing = data.source;
  if (typeof existing === 'string' && (NOTICE_SOURCES as readonly string[]).includes(existing)) {
    return existing as NoticeSource;
  }
  const createdBy = typeof data.createdBy === 'string' ? data.createdBy : '';
  const createdByEmail = typeof data.createdByEmail === 'string' ? data.createdByEmail.toLowerCase() : '';
  if (createdBy === 'usage_rollup' || createdByEmail === 'usage-monitor@system') return 'usage_monitor';
  if (docId.startsWith('billing_') || createdByEmail === 'billing@system') return 'billing';
  if (data.createdByRole === 'system' || createdBy === 'system' || createdByEmail.endsWith('@system')) {
    return 'system';
  }
  return 'user';
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The fields to write so a notice document is fully up to date with
 * NOTICE_SCHEMA_VERSION. Returns an empty object when nothing needs changing,
 * so running it twice is a no-op.
 *
 * Usage Monitor notices without an audience become admins-only.
 */
export function computeNoticeIndexPatch(data: Record<string, unknown>, docId: string): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  const source = inferNoticeSource(data, docId);

  let targetTenantRoles: unknown = data.targetTenantRoles;
  if (source === 'usage_monitor' && normalizeTargetTenantRoles(targetTenantRoles).length === 0) {
    targetTenantRoles = [...ADMIN_NOTICE_ROLES];
    patch.targetTenantRoles = targetTenantRoles;
  }

  const derived = deriveNoticeIndexFields({
    targetTenantRoles,
    imageUrl: data.imageUrl,
    audioUrl: data.audioUrl,
    linkUrl: data.linkUrl,
    source,
  });
  (Object.keys(derived) as (keyof NoticeIndexFields)[]).forEach((key) => {
    if (!sameValue(data[key], derived[key])) patch[key] = derived[key];
  });

  const reactionCount = countNoticeReactions(data.reactions);
  if (data.reactionCount !== reactionCount) patch.reactionCount = reactionCount;

  if (source !== 'user' && !data.createdByRole) patch.createdByRole = 'system';

  return patch;
}
