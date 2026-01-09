import type { IncomingMessage, Server } from 'http';
import * as admin from 'firebase-admin';
import { WebSocket, WebSocketServer } from 'ws';
import { ensureFirebase } from './firebaseAdmin';
import { decodeInternalToken, getConversationKey, normalizeEmail, watchConversationRealtime } from './chatRealtime';

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

export function setupChatWebsocket(server: Server): void {
  const wss = new WebSocketServer({ server, path: '/chat/ws' });

  wss.on('connection', async (socket: WebSocket, request: IncomingMessage) => {
    const url = (() => {
      try {
        return new URL(request.url || '', 'http://localhost');
      } catch {
        return null;
      }
    })();

    const token = url?.searchParams.get('token') ?? undefined;
    const tenantId = url?.searchParams.get('tenantId') ?? '';
    const userEmail = url?.searchParams.get('user') ?? '';
    const partnerEmail = url?.searchParams.get('partner') ?? '';

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
    const normalizedPartner = normalizeEmail(partnerEmail);
    const conversationKey = getConversationKey(normalizedUser, normalizedPartner);

    if (!normalizedUser || !normalizedPartner || !conversationKey) {
      socket.close(4400, 'invalid_conversation');
      return;
    }

    if (typeof tokenPayload.email === 'string' && normalizeEmail(tokenPayload.email) !== normalizedUser) {
      socket.close(4401, 'unauthorized');
      return;
    }

    const userIsMember = await isTenantEmailActiveMember(normalizedTenantId, normalizedUser);
    const partnerIsMember = await isTenantEmailActiveMember(normalizedTenantId, normalizedPartner);
    if (!userIsMember || !partnerIsMember) {
      socket.close(4403, 'not_authorized');
      return;
    }

    try {
      const cleanup = await watchConversationRealtime(normalizedTenantId, conversationKey, {
        onMessage: (message) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'message', payload: message }));
          }
        },
        onStatus: (status) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'status', payload: status }));
          }
        },
        onMessageUpdate: (message) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'message_update', payload: message }));
          }
        },
        onMessageDelete: (message) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'message_delete', payload: message }));
          }
        },
      });

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ready', payload: { tenantId: normalizedTenantId, conversationKey } }));
      }

      const heartbeat = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
        }
      }, 25000);

      const terminate = () => {
        clearInterval(heartbeat);
        cleanup();
      };

      socket.on('close', terminate);
      socket.on('error', terminate);
    } catch (error) {
      console.error('[chat-ws] watch failed', error);
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'status', payload: { error: 'internal_error' } }));
      }
      socket.close(1011, 'internal_error');
    }
  });
}
