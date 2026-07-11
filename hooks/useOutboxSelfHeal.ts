/**
 * useOutboxSelfHeal
 *
 * App-level outbox self-heal driver (chat-production-hardening, finding P1-1).
 *
 * The original outbox driver lived inside the chat SCREEN and only ran for the
 * currently-selected conversation, so a message queued/unconfirmed in another
 * conversation never resumed until that conversation was reopened. This hook is
 * mounted HIGH in the tree (see `TenantAwareShell` in `app/_layout.tsx`) so it
 * self-heals EVERY conversation's pending items — not just the open one —
 * whenever the app is online (and re-flushes promptly on reconnect / foreground /
 * relaunch).
 *
 * It reuses the shared, dependency-injected driver in `lib/outboxSelfHeal.ts`,
 * preserving the exact self-heal contract: bounded exponential backoff,
 * clientMsgId-idempotent re-drive, dead-lettering to `failed`, and authoritative
 * "Sent" confirmation via the confirmed-id set + `chatService.messageExistsById`.
 *
 * Duplicate drivers are avoided via conversation CLAIMS: the mounted chat screen
 * claims its selected recipient, and this driver skips any claimed recipient (so
 * the screen owns the open conversation and this hook owns all the others).
 */

import { useCallback, useEffect, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';

import { chatService } from '../services/chatService';
import { PendingMessageStorage } from '../lib/pendingMessageStorage';
import { resolveChatNormalizedMessageId } from '../lib/chatNormalizationState';
import { logger } from '../lib/logger';
import { useAuth } from './useAuthUnified';
import { useTenant } from './useTenantContext';
import { useNetworkStatus } from './useNetworkStatus';
import {
  OUTBOX_DRIVER_TICK_MS,
  createOutboxSelfHealState,
  driveOutboxSelfHealOnce,
  isOutboxRecipientClaimed,
  type OutboxSelfHealDeps,
} from '../lib/outboxSelfHeal';

export interface UseOutboxSelfHealOptions {
  /**
   * Master enable switch. When false the driver is fully idle (no ticks, no
   * listeners). Defaults to `true`; callers typically leave it default and rely
   * on the internal auth/tenant/connectivity gating below.
   */
  enabled?: boolean;
  /** Override the tick interval (ms). Primarily for tests. */
  tickMs?: number;
}

export function useOutboxSelfHeal(options?: UseOutboxSelfHealOptions): void {
  const { enabled = true, tickMs = OUTBOX_DRIVER_TICK_MS } = options ?? {};

  const { user } = useAuth();
  const { activeTenant } = useTenant();
  const { isOffline } = useNetworkStatus();

  const userEmail = user?.email ?? null;
  const tenantId = activeTenant?.id ?? null;

  // Runtime bookkeeping persists across ticks for the lifetime of the mount.
  const stateRef = useRef(createOutboxSelfHealState());
  // Guard so overlapping ticks (interval + foreground) never run concurrently.
  const drivingRef = useRef(false);

  const deps = useRef<OutboxSelfHealDeps>({
    loadPendingMessages: () => PendingMessageStorage.loadPendingMessages(),
    savePendingMessage: (id, message) =>
      PendingMessageStorage.addPendingMessage(id, message as any),
    removePendingMessages: (ids) => PendingMessageStorage.removePendingMessages(ids),
    sendMessage: (message) =>
      chatService.sendMessage({
        text: message.text,
        sender: message.sender,
        recipientId: message.recipientId,
        clientMsgId: message.clientMsgId,
        isSpecial: Boolean(message.isSpecial),
        replyTo: message.replyTo as any,
      }),
    messageExistsById: (sender, recipientId, serverMessageId) =>
      chatService.messageExistsById(sender, recipientId, serverMessageId),
    now: () => Date.now(),
    normalizeMessageId: (value) => resolveChatNormalizedMessageId(value),
    isRecipientClaimed: (recipientId) => isOutboxRecipientClaimed(recipientId),
    onError: (context, error) => logger.debug(context, error),
  }).current;

  const driveOnce = useCallback(async () => {
    if (drivingRef.current) {
      return;
    }
    drivingRef.current = true;
    try {
      await driveOutboxSelfHealOnce(deps, stateRef.current);
    } catch (error) {
      logger.debug('outboxSelfHeal.drive.failed', error);
    } finally {
      drivingRef.current = false;
    }
  }, [deps]);

  // The driver only runs while authenticated, tenant-scoped (so sends resolve a
  // tenant), and online. Any of these flipping true (reconnect, tenant resolve,
  // login) re-runs the effect and flushes immediately.
  const active = Boolean(enabled && userEmail && tenantId && !isOffline);

  useEffect(() => {
    if (!active) {
      return;
    }

    // Immediate flush on (re)activation — this is the reconnect / relaunch flush.
    void driveOnce();

    const interval = setInterval(() => {
      void driveOnce();
    }, tickMs);

    // Foreground flush: heal as soon as the app returns to the foreground.
    let appStateSub: { remove: () => void } | undefined;
    if (Platform.OS !== 'web' || typeof AppState.addEventListener === 'function') {
      const handleAppStateChange = (nextState: AppStateStatus) => {
        if (nextState === 'active') {
          void driveOnce();
        }
      };
      appStateSub = AppState.addEventListener('change', handleAppStateChange);
    }

    return () => {
      clearInterval(interval);
      appStateSub?.remove();
    };
  }, [active, driveOnce, tickMs]);
}
