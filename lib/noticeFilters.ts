import { where, type QueryFieldFilterConstraint } from 'firebase/firestore';
import type { Notice } from '../types/notice';

/** Filter chips in the notice list. Each maps to one Firestore equality filter. */
export type NoticeFilter = 'all' | 'high' | 'mine' | 'image' | 'audio' | 'adminsOnly';

export const NOTICE_FILTER_IDS: readonly NoticeFilter[] = ['all', 'high', 'mine', 'image', 'audio', 'adminsOnly'];

/**
 * Extra query constraints for a filter, on top of the tenant + visibility
 * constraints. Every combination has a composite index in
 * firestore.indexes.json (tenantId, visibleToRoles CONTAINS, <field>, createdAt DESC).
 */
export const noticeFilterConstraints = (filter: NoticeFilter, uid: string): QueryFieldFilterConstraint[] => {
  switch (filter) {
    case 'high':
      return [where('priority', '==', 'high')];
    case 'mine':
      return [where('createdBy', '==', uid)];
    case 'image':
      return [where('hasImage', '==', true)];
    case 'audio':
      return [where('hasAudio', '==', true)];
    case 'adminsOnly':
      return [where('roleRestricted', '==', true)];
    default:
      return [];
  }
};

/**
 * Client-side equivalent of `noticeFilterConstraints`, for notices the app is
 * holding locally (e.g. one mid-deletion). Falls back to the raw fields for
 * docs written before the index fields existed.
 */
export const matchesNoticeFilter = (notice: Notice, filter: NoticeFilter, uid: string | undefined): boolean => {
  switch (filter) {
    case 'high':
      return notice.priority === 'high';
    case 'mine':
      return Boolean(uid) && notice.createdBy === uid;
    case 'image':
      return notice.hasImage ?? Boolean(notice.imageUrl);
    case 'audio':
      return notice.hasAudio ?? Boolean(notice.audioUrl);
    case 'adminsOnly':
      return (
        notice.roleRestricted ??
        (Array.isArray(notice.targetTenantRoles) && notice.targetTenantRoles.length > 0)
      );
    default:
      return true;
  }
};
