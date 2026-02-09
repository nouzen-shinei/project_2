import { logger } from '@/lib/logger';
import { useState, useEffect } from 'react';
import { 
  collection, 
  addDoc, 
  updateDoc, 
  doc, 
  query, 
  orderBy, 
  onSnapshot, 
  runTransaction,
  serverTimestamp,
  increment,
  Timestamp,
  where
} from 'firebase/firestore';
import { firestore as db } from '../config/firebase';
import { useAuth, authService } from './useAuthUnified';
import { Notice, NoticeFormData } from '../types/notice';
import { noticeService } from '../services/noticeService';
import { useTenant } from './useTenantContext';
import type { TenantMembershipRole } from '../types/tenant';
import { noticeBackendClient } from '../services/noticeBackendClient';

export const useNotices = () => {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();
  const { activeTenant, activeMembership } = useTenant();
  const [reinitKey, setReinitKey] = useState(0);

  useEffect(() => {
    const unsubscribe = authService.registerFirestoreReinit?.(() => {
      setReinitKey((prev) => prev + 1);
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {}
    };
  }, []);

  const isNoticeVisibleForRole = (notice: Notice, role: TenantMembershipRole | null | undefined): boolean => {
    const targets = (notice as any)?.targetTenantRoles;
    if (!Array.isArray(targets) || targets.length === 0) {
      return true;
    }
    if (!role) {
      return false;
    }
    return targets.includes(role);
  };

  useEffect(() => {
    if (!user || !activeTenant?.id) {
      setNotices([]);
      setLoading(false);
      return () => undefined;
    }

    setLoading(true);
    const noticesQuery = query(
      collection(db, 'notices'),
      where('tenantId', '==', activeTenant.id),
      orderBy('createdAt', 'desc')
    );

    const unsubscribe = onSnapshot(noticesQuery, (snapshot) => {
      const noticesData: Notice[] = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        noticesData.push({
          id: doc.id,
          ...data,
          createdAt: data.createdAt?.toDate?.()?.toISOString() || data.createdAt,
          updatedAt: data.updatedAt?.toDate?.()?.toISOString() || data.updatedAt,
          tenantId: data.tenantId,
        } as Notice);
      });
      const role = activeMembership?.role || null;
      setNotices(noticesData.filter((n) => isNoticeVisibleForRole(n, role)));
      setLoading(false);
    }, (error) => {
      logger.error('[useNotices] Error loading notices:', error);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [user, activeTenant?.id, activeMembership?.role, reinitKey]);

  const addNotice = async (noticeData: NoticeFormData): Promise<string> => {
    if (!user) throw new Error('User not authenticated');
    if (!activeTenant?.id) throw new Error('Select a coaching center before creating notices');

    const createdByRole: TenantMembershipRole = activeMembership?.role || 'member';

    const newNotice = {
      ...noticeData,
      tenantId: activeTenant.id,
      createdAt: serverTimestamp(),
      createdBy: user.uid,
      createdByRole,
      createdByName: user.displayName || user.email?.split('@')[0] || 'Unknown User',
      createdByEmail: user.email || '',
      isActive: true,
      viewCount: 0,
      userViews: {},
    };

    const docRef = await addDoc(collection(db, 'notices'), newNotice);

    const createdAtIso = new Date().toISOString();
    const targetAudience = Array.isArray(noticeData.targetAudience) && noticeData.targetAudience.length > 0
      ? [...noticeData.targetAudience]
      : ['all'];

    const dispatchNotice: Notice = {
      id: docRef.id,
      title: noticeData.title,
      content: noticeData.content,
      imageUrl: noticeData.imageUrl,
      audioUrl: noticeData.audioUrl,
      audioFileName: noticeData.audioFileName,
      audioFileSize: noticeData.audioFileSize,
      audioDurationMs: noticeData.audioDurationMs,
      audioStoragePath: noticeData.audioStoragePath,
      linkUrl: noticeData.linkUrl,
      linkTitle: noticeData.linkTitle,
      priority: noticeData.priority,
      createdAt: createdAtIso,
      createdBy: user.uid,
      createdByRole,
      createdByName: newNotice.createdByName,
      createdByEmail: newNotice.createdByEmail,
      updatedAt: createdAtIso,
      isActive: true,
      targetTenantRoles: noticeData.targetTenantRoles,
      targetAudience,
      tenantId: activeTenant.id,
      viewCount: 0,
      userViews: {},
    };

    noticeService.notifyNewNotice(dispatchNotice).catch((error) => {
      logger.warn('[useNotices] Failed to dispatch notice notifications:', error);
    });

    return docRef.id;
  };

  const updateNotice = async (noticeId: string, updates: Partial<NoticeFormData>): Promise<void> => {
    if (!user) throw new Error('User not authenticated');
    if (!activeTenant?.id) throw new Error('Select a coaching center before updating notices');

    const noticeRef = doc(db, 'notices', noticeId);
    await updateDoc(noticeRef, {
      ...updates,
      updatedAt: serverTimestamp(),
    });
  };

  const deleteNotice = async (noticeId: string): Promise<void> => {
    if (!user) throw new Error('User not authenticated');
    if (!activeTenant?.id) throw new Error('Select a coaching center before deleting notices');

    // Server is the source of truth for delete permissions.
    await noticeBackendClient.deleteNotice({ tenantId: activeTenant.id, noticeId });
  };

  const markNoticeAsViewed = async (noticeId: string): Promise<void> => {
    if (!user || !activeTenant?.id) return;

    const noticeRef = doc(db, 'notices', noticeId);
    const currentCount = notices.find(n => n.id === noticeId)?.userViews?.[user.uid]?.count || 0;

    await updateDoc(noticeRef, {
      viewCount: increment(1),
      [`userViews.${user.uid}`]: {
        count: currentCount + 1,
        lastViewed: Timestamp.now(),
      },
    });
  };

  const toggleNoticeReaction = async (params: { noticeId: string; reactionType: string }): Promise<void> => {
    if (!user) throw new Error('User not authenticated');
    if (!activeTenant?.id) throw new Error('Select a coaching center before reacting to notices');

    const noticeId = params.noticeId;
    const reactionType = (params.reactionType || '').trim();
    if (!reactionType) throw new Error('Reaction type is required');
    if (reactionType.length > 32) throw new Error('Reaction type is too long');

    const noticeRef = doc(db, 'notices', noticeId);
    const userId = user.uid;

    await runTransaction(db, async (tx) => {
      const snap = await tx.get(noticeRef);
      if (!snap.exists()) {
        throw new Error('Notice not found');
      }

      const data = snap.data() as any;
      const currentReactionsRaw = data?.reactions;
      const currentReactions: Record<string, string[]> =
        currentReactionsRaw && typeof currentReactionsRaw === 'object' && !Array.isArray(currentReactionsRaw)
          ? (currentReactionsRaw as Record<string, string[]>)
          : {};

      // One reaction per user: remove userId from any existing reaction first.
      let removedFrom: string | null = null;
      const nextReactions: Record<string, string[]> = {};

      for (const [type, rawUsers] of Object.entries(currentReactions)) {
        const users = Array.isArray(rawUsers) ? rawUsers.filter((v) => typeof v === 'string') : [];
        const hadUser = users.includes(userId);
        const filtered = hadUser ? users.filter((id) => id !== userId) : users;

        if (hadUser) {
          removedFrom = type;
        }

        const unique = Array.from(new Set(filtered));
        if (unique.length > 0) {
          nextReactions[type] = unique;
        }
      }

      // If user tapped the same reaction they already had, toggling off ends here.
      if (removedFrom === reactionType) {
        tx.update(noticeRef, {
          reactions: nextReactions,
          updatedAt: serverTimestamp(),
        });
        return;
      }

      const existing = Array.isArray(nextReactions[reactionType]) ? nextReactions[reactionType] : [];
      nextReactions[reactionType] = Array.from(new Set([...existing, userId]));

      tx.update(noticeRef, {
        reactions: nextReactions,
        updatedAt: serverTimestamp(),
      });
    });
  };

  const getUnviewedNotices = (): Notice[] => {
    if (!user) return [];

    return notices.filter(notice => {
      if (!notice.isActive) return false;
      
      const userView = notice.userViews?.[user.uid];
      if (!userView) return true; // Never viewed
      
      return userView.count < 2; // Shown less than 2 times
    });
  };

  const getPendingNotices = (): Notice[] => {
    if (!user) return [];

    const fourteenDaysAgo = new Date();
    fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

    const filtered = notices.filter(notice => {
      if (!notice.isActive) return false;
      
      const createdAt = new Date(notice.createdAt);
      const userView = notice.userViews?.[user.uid];
      
      const isRecent = createdAt > fourteenDaysAgo;
      const viewCount = userView ? userView.count : 0;
      const shouldShow = isRecent && viewCount < 2;
      
      return shouldShow;
    });

    return filtered;
  };

  const getNoticesByPriority = (priority: 'high' | 'medium' | 'low'): Notice[] => {
    return notices.filter(notice => notice.isActive && notice.priority === priority);
  };

  return {
    notices,
    loading,
    addNotice,
    updateNotice,
    deleteNotice,
    markNoticeAsViewed,
    toggleNoticeReaction,
    getUnviewedNotices,
    getPendingNotices,
    getNoticesByPriority,
  };
};
