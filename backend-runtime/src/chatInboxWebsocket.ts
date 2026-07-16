import type { IncomingMessage, Server } from 'http';
import * as admin from 'firebase-admin';
import { WebSocket, WebSocketServer } from 'ws';
import { ensureFirebase } from './firebaseAdmin';
import { decodeInternalToken, normalizeEmail, watchUserInboxRealtime } from './chatRealtime';

// Per-user inbound-message WebSocket. Native clients (no EventSource) use this
// instead of the SSE `/chat/inbox-stream` endpoint. It streams the SAME compact
// inbound events for the CALLER'S OWN inbox and enforces the SAME auth: an
// internal token is required, the actor is taken from the token (its `email`
// claim must match the `user` query param), and the user must be an active
// tenant member. See `watchUserInboxRealtime` and `/chat/inbox-stream`.

function parseRequestQueryParams(requestUrl?: string): URLSearchParams {
  const queryIndex = (requestUrl ?? '').indexOf('?');
  const query = queryIndex >= 0 ? (requestUrl ?? '').slice(queryIndex + 1) : '';
  return new URLSearchParams(query);
}

async function isTenantEmailActiveMember(tenantId: string, email: string): Promise<boolean> {
  const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedTenantId || !normalizedEmail) {
    return false;
  }

  ensureFirebase();
  const db = admin.firestore();
  const snapshot = await db
    .collection('tenantMemberships')
    .where('tenantId', '==', normalizedTenantId)
    .where('status', '==', 'active')
    .where('email', '==', normalizedEmail)
    .limit(1)
    .get();
  return !snapshot.empty;
}

export function setupChatInboxWebsocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/chat/inbox-ws' });

  wss.on('connection', async (socket: WebSocket, request: IncomingMessage) => {
    const searchParams = parseRequestQueryParams(request.url);

    const token = searchParams.get('token') ?? undefined;
    const tenantId = searchParams.get('tenantId') ?? '';
    const userEmail = searchParams.get('user') ?? '';

    const tokenPayload = decodeInternalToken(token);
    if (!token || !tokenPayload) {
      socket.close(4401, 'unauthorized');
      return;
    }

    const normalizedTenantId = typeof tenantId === 'string' ? tenantId.trim() : '';
    if (!normalizedTenantId) {
      socket.close(4400, 'tenant_required');
      return;
    }

    const normalizedUser = normalizeEmail(userEmail);
    if (!normalizedUser) {
      socket.close(4400, 'invalid_user');
      return;
    }

    // Actor is derived from the token, never trusted from the query param.
    // Require an email on non-master tokens (only the raw master key is exempt)
    // rather than skipping the check when it's absent (security-rules-hardening L5).
    if (!tokenPayload.master && normalizeEmail(tokenPayload.email ?? '') !== normalizedUser) {
      socket.close(4401, 'unauthorized');
      return;
    }

    const userIsMember = await isTenantEmailActiveMember(normalizedTenantId, normalizedUser);
    if (!userIsMember) {
      socket.close(4403, 'not_authorized');
      return;
    }

    try {
      let cleanup: (() => void) | null = null;
      let heartbeat: NodeJS.Timeout | null = null;
      let terminated = false;

      const terminate = () => {
        if (terminated) {
          return;
        }
        terminated = true;
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        cleanup?.();
        cleanup = null;
      };

      socket.on('close', terminate);
      socket.on('error', terminate);

      cleanup = await watchUserInboxRealtime(normalizedTenantId, normalizedUser, {
        onInbound: (payload) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'inbound', payload }));
          }
        },
      });

      if (socket.readyState !== WebSocket.OPEN) {
        terminate();
        return;
      }

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ready', payload: { tenantId: normalizedTenantId, user: normalizedUser } }));
      }

      heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
      }, 25000);
    } catch (error) {
      console.error('[chat-inbox-ws] watch failed', error);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'status', payload: { error: 'internal_error' } }));
      }
      socket.close(1011, 'internal_error');
    }
  });
}
