/**
 * useUnreadChatCount
 *
 * Subscribes to the current user's conversation summaries via a single
 * Firebase RTDB listener and returns a stable `hasUnread` boolean.
 *
 * Design choices for production / performance:
 *
 *  • Returns `boolean` not `number` — React bails out of re-renders when
 *    setState is called with the same value, so rendering is only triggered
 *    when the unread state flips (0 → >0 or >0 → 0), not on every count
 *    change inside the chat screen.
 *
 *  • `isActive` guard prevents stale setState after unmount / tenant switch.
 *
 *  • Re-subscribes only when the user email or active tenant id change; all
 *    other component renders are free.
 *
 *  • The firebase listener is already debounced / batched by the RTDB SDK;
 *    no additional debounce is needed here.
 */

import { useEffect, useState } from 'react';
import { chatService } from '../services/chatService';
import { useAuth } from './useAuthUnified';
import { useTenant } from './useTenantContext';

export function useUnreadChatCount(): boolean {
  const { user } = useAuth();
  const { activeTenant } = useTenant();

  const userEmail = user?.email ?? null;
  const tenantId = activeTenant?.id ?? null;

  const [hasUnread, setHasUnread] = useState(false);

  useEffect(() => {
    // Both are required to form a valid subscription.
    if (!userEmail || !tenantId) {
      setHasUnread(false);
      return;
    }

    let isActive = true;

    const unsubscribe = chatService.onConversationSummariesChange(
      userEmail,
      (records) => {
        if (!isActive) return;

        // Mirror the tenant-scoped filter that chat.tsx applies in buildSummaryMap.
        const trimmedTenantId = tenantId.trim();
        const next = Object.values(records).some(
          (summary) =>
            summary?.tenantId?.trim() === trimmedTenantId &&
            summary.unreadCount > 0,
        );

        // React skips re-render when the value is unchanged — this is the
        // key optimisation that keeps the tab bar from re-rendering on every
        // Firebase push that doesn't change the true/false boundary.
        setHasUnread(next);
      },
    );

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [userEmail, tenantId]);

  return hasUnread;
}
