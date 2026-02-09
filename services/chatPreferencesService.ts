import { logger } from '@/lib/logger';
import { doc, getDoc, onSnapshot, setDoc, updateDoc, deleteField, runTransaction } from 'firebase/firestore';
import { firestore } from '@/config/firebase';
import { authService } from '@/hooks/useAuthUnified';

export type PinnedChatsMap = Record<string, number>; // key = sanitized email ([@,.] -> _), value = serial

const sanitizeEmailKey = (email: string) => email.toLowerCase().replace(/[@.]/g, '_');

const userDocRef = (email: string) => doc(firestore, 'authorizedEmails', sanitizeEmailKey(email));

export const chatPreferencesService = {
  sanitizeEmailKey,

  async getPinnedChats(userEmail: string): Promise<PinnedChatsMap> {
    try {
      const snap = await getDoc(userDocRef(userEmail));
      const data = snap.exists() ? (snap.data() as any) : {};
      return (data.pinnedChats as PinnedChatsMap) || {};
    } catch (e) {
      logger.warn('Failed to get pinned chats:', e);
      return {};
    }
  },

  onPinnedChatsChange(userEmail: string, cb: (map: PinnedChatsMap) => void) {
    const ref = userDocRef(userEmail);
    let disposed = false;
    let unsubscribe: (() => void) | null = null;

    const attach = (context?: string) => {
      if (disposed) return;
      unsubscribe?.();
      unsubscribe = onSnapshot(ref, (snap) => {
        const data = snap.exists() ? (snap.data() as any) : {};
        cb((data.pinnedChats as PinnedChatsMap) || {});
      });

      if (context) {
        logger.debug('chatPreferencesService.onPinnedChatsChange reattached', { context });
      }
    };

    attach('initial');
    const unregister = authService.registerFirestoreReinit?.(() => attach('reinit'));

    return () => {
      disposed = true;
      unsubscribe?.();
      try {
        unregister?.();
      } catch {}
    };
  },

  async pinChat(userEmail: string, otherEmail: string): Promise<PinnedChatsMap> {
    const ref = userDocRef(userEmail);
    await runTransaction(firestore, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? (snap.data() as any) : {};
      const current: PinnedChatsMap = (data.pinnedChats as PinnedChatsMap) || {};
      const key = sanitizeEmailKey(otherEmail);
      if (current[key] != null) return; // already pinned
      // Next serial is length+1, since unpin normalizes serials to 1..N
      const nextSerial = Object.keys(current).length + 1;
      const updated: PinnedChatsMap = { ...current, [key]: nextSerial };
      tx.set(ref, { pinnedChats: updated, pinnedChatsUpdatedAt: new Date().toISOString() }, { merge: true });
    });

    const latest = await getDoc(ref);
    const latestData = latest.exists() ? (latest.data() as any) : {};
    return (latestData.pinnedChats as PinnedChatsMap) || {};
  },

  async unpinChat(userEmail: string, otherEmail: string): Promise<PinnedChatsMap> {
    const ref = userDocRef(userEmail);
    const key = sanitizeEmailKey(otherEmail);
    await runTransaction(firestore, async (tx) => {
      const snap = await tx.get(ref);
      const data = snap.exists() ? (snap.data() as any) : {};
      const current: PinnedChatsMap = (data.pinnedChats as PinnedChatsMap) || {};
      if (current[key] == null) return; // nothing to do
      // Remove the key first
  tx.update(ref, { [`pinnedChats.${key}`]: deleteField(), pinnedChatsUpdatedAt: new Date().toISOString() } as any);
      const remainingEntries = Object.entries(current)
        .filter(([k]) => k !== key)
        .sort((a, b) => {
          const av = typeof a[1] === 'number' ? a[1] : 0;
          const bv = typeof b[1] === 'number' ? b[1] : 0;
          return av - bv; // keep existing order by serial
        });
      // Re-number serials to be contiguous starting from 1
      const normalized: PinnedChatsMap = {};
      let serial = 1;
      for (const [k] of remainingEntries) {
        normalized[k] = serial++;
      }
  // Write normalized map; merge will overwrite values for existing keys
  tx.set(ref, { pinnedChats: normalized, pinnedChatsUpdatedAt: new Date().toISOString() }, { merge: true });
    });

    const latest = await getDoc(ref);
    const latestData = latest.exists() ? (latest.data() as any) : {};
    return (latestData.pinnedChats as PinnedChatsMap) || {};
  },

  async setPinnedOrder(userEmail: string, orderedEmails: string[]): Promise<PinnedChatsMap> {
    const ref = userDocRef(userEmail);
    // Assign serials starting from 1 in given order
    const updated: PinnedChatsMap = {};
    orderedEmails.forEach((email, idx) => {
      updated[sanitizeEmailKey(email)] = idx + 1;
    });
    await setDoc(ref, { pinnedChats: updated, pinnedChatsUpdatedAt: new Date().toISOString() }, { merge: true });
    return updated;
  },
};
