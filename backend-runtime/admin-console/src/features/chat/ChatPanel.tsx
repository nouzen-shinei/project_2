import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { SectionCard } from '../../components/SectionCard';
import { deleteChatMessage, editChatMessage, fetchChatDelta, fetchTenantUserDevices, sendChatMessage } from '../../lib/apiClient';
import { resolveBaseUrl, useConfigStore } from '../../store/configStore';

const deltaSchema = z.object({
  userEmail: z.string().email(),
  partnerEmail: z.string().email(),
  tenantId: z.string().min(1),
  direction: z.enum(['latest', 'older', 'newer']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursorTimestamp: z.string().optional(),
  cursorMessageId: z.string().optional(),
});

type DeltaForm = z.infer<typeof deltaSchema>;

const sendSchema = z.object({
  recipientId: z.string().email(),
  tenantId: z.string().min(1),
  text: z.string().optional(),
  isSpecial: z.boolean().optional(),
});

type SendForm = z.infer<typeof sendSchema>;

const editSchema = z.object({ id: z.string().min(1), text: z.string().min(1), tenantId: z.string().min(1) });

type EditForm = z.infer<typeof editSchema>;

const deleteSchema = z.object({ id: z.string().min(1), tenantId: z.string().min(1) });

type DeleteForm = z.infer<typeof deleteSchema>;

const streamSchema = z.object({
  userEmail: z.string().email(),
  partnerEmail: z.string().email(),
  token: z.string().min(10),
});

type StreamForm = z.infer<typeof streamSchema>;

const receiptInspectorSchema = z.object({
  userEmail: z.string().email(),
  partnerEmail: z.string().email(),
  tenantId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

type ReceiptInspectorForm = z.infer<typeof receiptInspectorSchema>;

interface ChatEvent {
  id: string;
  raw: unknown;
}

interface ReceiptInspectorMessage {
  id?: string;
  text?: string;
  timestamp?: string;
  delivered?: boolean;
  read?: boolean;
  deliveredAt?: string;
  readAt?: string;
  deliveryProvenance?: {
    sources?: Array<'presence' | 'push'>;
    lastSource?: 'presence' | 'push';
    lastUpdatedAt?: string;
    presence?: {
      deliveredAt?: string;
      onlineDeviceCount?: number;
      focusedDeviceCount?: number;
    };
    push?: {
      deliveredAt?: string;
      acceptedDeviceCount?: number;
      mobileAcceptedCount?: number;
      webAcceptedCount?: number;
    };
  };
}

interface ReceiptInspectorResult {
  generatedAt: string;
  summary: {
    inspectedMessageCount: number;
    deliveredCount: number;
    readCount: number;
    recipientDeviceCount: number;
    focusedRecipientDevices: number;
  };
  recipientDevices: unknown[];
  messages: ReceiptInspectorMessage[];
}

function getReceiptStatus(message: ReceiptInspectorMessage): 'read' | 'delivered' | 'sent' {
  if (message.read) {
    return 'read';
  }
  if (message.delivered) {
    return 'delivered';
  }
  return 'sent';
}

function formatReceiptTime(value?: string): string {
  if (!value) {
    return '—';
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }

  return new Date(parsed).toLocaleString();
}

function hasDeliverySource(message: ReceiptInspectorMessage, source: 'presence' | 'push'): boolean {
  return Boolean(message.deliveryProvenance?.sources?.includes(source) || message.deliveryProvenance?.lastSource === source);
}

function formatPresenceSummary(message: ReceiptInspectorMessage): string | null {
  const presence = message.deliveryProvenance?.presence;
  if (!presence) {
    return null;
  }

  const parts: string[] = [];
  if (typeof presence.onlineDeviceCount === 'number') {
    parts.push(`${presence.onlineDeviceCount} online`);
  }
  if (typeof presence.focusedDeviceCount === 'number') {
    parts.push(`${presence.focusedDeviceCount} focused`);
  }
  const deliveredAt = formatReceiptTime(presence.deliveredAt);
  if (deliveredAt !== '—') {
    parts.push(`at ${deliveredAt}`);
  }

  return parts.length ? `Presence ${parts.join(' • ')}` : 'Presence delivery';
}

function formatPushSummary(message: ReceiptInspectorMessage): string | null {
  const push = message.deliveryProvenance?.push;
  if (!push) {
    return null;
  }

  const parts: string[] = [];
  if (typeof push.acceptedDeviceCount === 'number') {
    parts.push(`${push.acceptedDeviceCount} accepted`);
  }
  if (typeof push.mobileAcceptedCount === 'number') {
    parts.push(`${push.mobileAcceptedCount} mobile`);
  }
  if (typeof push.webAcceptedCount === 'number') {
    parts.push(`${push.webAcceptedCount} web`);
  }
  const deliveredAt = formatReceiptTime(push.deliveredAt);
  if (deliveredAt !== '—') {
    parts.push(`at ${deliveredAt}`);
  }

  return parts.length ? `Push ${parts.join(' • ')}` : 'Push delivery';
}

export function ChatPanel() {
  const deltaForm = useForm<DeltaForm>({ resolver: zodResolver(deltaSchema) });
  const sendForm = useForm<SendForm>({ resolver: zodResolver(sendSchema) });
  const editForm = useForm<EditForm>({ resolver: zodResolver(editSchema) });
  const deleteForm = useForm<DeleteForm>({ resolver: zodResolver(deleteSchema) });
  const streamForm = useForm<StreamForm>({ resolver: zodResolver(streamSchema), defaultValues: { token: useConfigStore.getState().bearerToken } });
  const receiptInspectorForm = useForm<ReceiptInspectorForm>({
    resolver: zodResolver(receiptInspectorSchema),
    defaultValues: { limit: 20 },
  });
  const [deltaResult, setDeltaResult] = useState<unknown>(null);
  const [receiptInspectorResult, setReceiptInspectorResult] = useState<ReceiptInspectorResult | null>(null);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const deltaString = useMemo(() => (deltaResult ? JSON.stringify(deltaResult, null, 2) : null), [deltaResult]);
  const receiptInspectorString = useMemo(
    () => (receiptInspectorResult ? JSON.stringify(receiptInspectorResult, null, 2) : null),
    [receiptInspectorResult]
  );
  const receiptInspectorMessages = useMemo(
    () => (Array.isArray(receiptInspectorResult?.messages) ? receiptInspectorResult.messages : []),
    [receiptInspectorResult]
  );
  const deliveredOnlyCount = useMemo(
    () => receiptInspectorMessages.filter((message) => message.delivered && !message.read).length,
    [receiptInspectorMessages]
  );
  const sentOnlyCount = useMemo(
    () => receiptInspectorMessages.filter((message) => !message.delivered && !message.read).length,
    [receiptInspectorMessages]
  );
  const presenceProvenanceCount = useMemo(
    () => receiptInspectorMessages.filter((message) => hasDeliverySource(message, 'presence')).length,
    [receiptInspectorMessages]
  );
  const pushProvenanceCount = useMemo(
    () => receiptInspectorMessages.filter((message) => hasDeliverySource(message, 'push')).length,
    [receiptInspectorMessages]
  );

  const connectStream = streamForm.handleSubmit((payload: StreamForm) => {
    try {
      const base = resolveBaseUrl();
      const url = new URL('/chat/stream', base.endsWith('/') ? base : `${base}/`);
      url.searchParams.set('token', payload.token);
      url.searchParams.set('user', payload.userEmail);
      url.searchParams.set('partner', payload.partnerEmail);

      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }

      const source = new EventSource(url.toString());
      eventSourceRef.current = source;
      setStreaming(true);
      setEvents([]);

      source.onmessage = (event) => {
        try {
          setEvents((prev) => [{ id: `${Date.now()}`, raw: JSON.parse(event.data) }, ...prev].slice(0, 50));
        } catch {
          setEvents((prev) => [{ id: `${Date.now()}`, raw: event.data }, ...prev].slice(0, 50));
        }
      };
      source.onerror = () => {
        setStreaming(false);
        source.close();
      };
    } catch (err: any) {
      alert(err?.message || 'Failed to open stream');
    }
  });

  useEffect(() => () => eventSourceRef.current?.close(), []);

  const latestEvent = useMemo(() => events[0], [events]);

  return (
    <SectionCard title="Chat Tools" description="Inspect deltas, drop realtime streams, and mutate chat messages.">
      <form
        className="form-grid"
        onSubmit={deltaForm.handleSubmit(async (payload: DeltaForm) => {
          try {
            const cursor = payload.cursorTimestamp || payload.cursorMessageId
              ? { timestamp: payload.cursorTimestamp, messageId: payload.cursorMessageId }
              : undefined;
            const result = await fetchChatDelta({
              userEmail: payload.userEmail,
              partnerEmail: payload.partnerEmail,
              tenantId: payload.tenantId,
              direction: payload.direction,
              limit: payload.limit,
              cursor,
            });
            setDeltaResult(result);
          } catch (err: any) {
            alert(err?.message || 'Chat delta failed');
          }
        })}
      >
        <h3>Delta Fetch</h3>
        <label>
          User email
          <input {...deltaForm.register('userEmail')} />
        </label>
        <label>
          Partner email
          <input {...deltaForm.register('partnerEmail')} />
        </label>
        <label>
          Tenant ID
          <input {...deltaForm.register('tenantId')} />
        </label>
        <label>
          Direction
          <select {...deltaForm.register('direction')}>
            <option value="">older (default)</option>
            <option value="latest">latest</option>
            <option value="newer">newer</option>
          </select>
        </label>
        <label>
          Limit (max 200)
          <input type="number" {...deltaForm.register('limit', { valueAsNumber: true })} />
        </label>
        <label>
          Cursor timestamp
          <input {...deltaForm.register('cursorTimestamp')} />
        </label>
        <label>
          Cursor messageId
          <input {...deltaForm.register('cursorMessageId')} />
        </label>
        <button className="primary-button" type="submit">Fetch messages</button>
      </form>
      {deltaString && (
        <pre className="code-block" style={{ maxHeight: 220 }}>
          {deltaString}
        </pre>
      )}

      <hr style={{ opacity: 0.2 }} />
      <form
        className="form-grid"
        onSubmit={receiptInspectorForm.handleSubmit(async (payload: ReceiptInspectorForm) => {
          try {
            const [delta, devices] = await Promise.all([
              fetchChatDelta({
                userEmail: payload.userEmail,
                partnerEmail: payload.partnerEmail,
                tenantId: payload.tenantId,
                direction: 'latest',
                limit: payload.limit ?? 20,
              }),
              fetchTenantUserDevices({
                tenantId: payload.tenantId,
                email: payload.partnerEmail,
              }),
            ]);

            const messages = Array.isArray((delta as any)?.messages) ? (delta as any).messages : [];
            const relevantMessages = messages
              .filter((message: any) => {
                const sender = typeof message?.sender === 'string' ? message.sender.toLowerCase() : '';
                const recipient = typeof message?.recipientId === 'string' ? message.recipientId.toLowerCase() : '';
                return sender === payload.userEmail.toLowerCase() && recipient === payload.partnerEmail.toLowerCase();
              })
              .slice(-Math.max(1, payload.limit ?? 20));

            const deliveredCount = relevantMessages.filter((message: any) => message?.delivered === true).length;
            const readCount = relevantMessages.filter((message: any) => message?.read === true).length;
            const focusedRecipientDevices = Array.isArray((devices as any)?.devices)
              ? (devices as any).devices.filter(
                  (device: any) =>
                    device?.activeChatIsFocused === true
                    && typeof device?.activeChatPartner === 'string'
                    && device.activeChatPartner.toLowerCase() === payload.userEmail.toLowerCase()
                ).length
              : 0;

            setReceiptInspectorResult({
              generatedAt: new Date().toISOString(),
              summary: {
                inspectedMessageCount: relevantMessages.length,
                deliveredCount,
                readCount,
                recipientDeviceCount: Array.isArray((devices as any)?.devices) ? (devices as any).devices.length : 0,
                focusedRecipientDevices,
              },
              recipientDevices: (devices as any)?.devices ?? [],
              messages: relevantMessages,
            });
          } catch (err: any) {
            alert(err?.message || 'Receipt inspection failed');
          }
        })}
      >
        <h3>Receipt Verification</h3>
        <label>
          Sender email
          <input {...receiptInspectorForm.register('userEmail')} />
        </label>
        <label>
          Recipient email
          <input {...receiptInspectorForm.register('partnerEmail')} />
        </label>
        <label>
          Tenant ID
          <input {...receiptInspectorForm.register('tenantId')} />
        </label>
        <label>
          Recent message limit
          <input type="number" {...receiptInspectorForm.register('limit', { valueAsNumber: true })} />
        </label>
        <button className="primary-button" type="submit">Inspect receipts</button>
      </form>
      {receiptInspectorResult && (
        <div className="receipt-inspector-panel">
          <div className="receipt-chip-row">
            <span className="receipt-chip receipt-chip--read">Read {receiptInspectorResult.summary.readCount}</span>
            <span className="receipt-chip receipt-chip--delivered">Delivered only {deliveredOnlyCount}</span>
            <span className="receipt-chip receipt-chip--sent">Sent only {sentOnlyCount}</span>
            <span className="receipt-chip receipt-chip--presence">Presence evidence {presenceProvenanceCount}</span>
            <span className="receipt-chip receipt-chip--push">Push evidence {pushProvenanceCount}</span>
            <span className="receipt-chip receipt-chip--neutral">
              Focused recipient devices {receiptInspectorResult.summary.focusedRecipientDevices}
            </span>
          </div>
          <div className="receipt-timeline">
            {receiptInspectorMessages.map((message) => {
              const status = getReceiptStatus(message);
              const preview = (message.text || '').trim() || '(attachment/sticker)';
              const shortId = typeof message.id === 'string' ? message.id.slice(-8) : 'unknown';
              const presenceSummary = formatPresenceSummary(message);
              const pushSummary = formatPushSummary(message);
              const provenanceUpdatedAt = formatReceiptTime(message.deliveryProvenance?.lastUpdatedAt);

              return (
                <div className="receipt-message-row" key={message.id || `${message.timestamp}-${preview}`}>
                  <div className="receipt-message-main">
                    <span className={`receipt-chip receipt-chip--${status}`}>
                      {status === 'read' ? 'Read' : status === 'delivered' ? 'Delivered' : 'Sent'}
                    </span>
                    <strong className="receipt-message-id">#{shortId}</strong>
                    <span className="receipt-message-preview" title={preview}>{preview}</span>
                    {hasDeliverySource(message, 'presence') && (
                      <span className="receipt-chip receipt-chip--presence">Presence</span>
                    )}
                    {hasDeliverySource(message, 'push') && (
                      <span className="receipt-chip receipt-chip--push">Push</span>
                    )}
                    {message.deliveryProvenance?.lastSource && (
                      <span className="receipt-chip receipt-chip--neutral">
                        Last {message.deliveryProvenance.lastSource}
                      </span>
                    )}
                  </div>
                  <div className="receipt-message-meta">
                    <span>Sent {formatReceiptTime(message.timestamp)}</span>
                    <span>Delivered {formatReceiptTime(message.deliveredAt)}</span>
                    <span>Read {formatReceiptTime(message.readAt)}</span>
                    {presenceSummary && <span>{presenceSummary}</span>}
                    {pushSummary && <span>{pushSummary}</span>}
                    {provenanceUpdatedAt !== '—' && <span>Provenance updated {provenanceUpdatedAt}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {receiptInspectorString && (
        <pre className="code-block" style={{ maxHeight: 260 }}>
          {receiptInspectorString}
        </pre>
      )}

      <hr style={{ opacity: 0.2 }} />
      <div className="form-grid">
        <form
          onSubmit={sendForm.handleSubmit(async (payload: SendForm) => {
            try {
              await sendChatMessage({
                recipientId: payload.recipientId,
                tenantId: payload.tenantId,
                text: payload.text,
                isSpecial: payload.isSpecial,
              });
              sendForm.reset({ tenantId: payload.tenantId });
            } catch (err: any) {
              alert(err?.message || 'Send failed');
            }
          })}
        >
          <h3>Send message</h3>
          <label>
            Recipient email
            <input {...sendForm.register('recipientId')} />
          </label>
          <label>
            Tenant ID
            <input {...sendForm.register('tenantId')} placeholder="tenant_123" />
          </label>
          <label>
            Text
            <textarea className="textarea" {...sendForm.register('text')} />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <input type="checkbox" {...sendForm.register('isSpecial')} /> Mark as special
          </label>
          <button className="primary-button" type="submit">Send</button>
        </form>

        <form
          onSubmit={editForm.handleSubmit(async (payload: EditForm) => {
            try {
              await editChatMessage(payload.id, { text: payload.text, tenantId: payload.tenantId });
              editForm.reset({ tenantId: payload.tenantId });
            } catch (err: any) {
              alert(err?.message || 'Edit failed');
            }
          })}
        >
          <h3>Edit message</h3>
          <label>
            Message ID
            <input {...editForm.register('id')} />
          </label>
          <label>
            Replacement text
            <textarea className="textarea" {...editForm.register('text')} />
          </label>
          <label>
            Tenant ID
            <input {...editForm.register('tenantId')} />
          </label>
          <button className="primary-button" type="submit">Apply edit</button>
        </form>

        <form
          onSubmit={deleteForm.handleSubmit(async (payload: DeleteForm) => {
            try {
              await deleteChatMessage(payload.id, payload.tenantId);
              deleteForm.reset({ tenantId: payload.tenantId });
            } catch (err: any) {
              alert(err?.message || 'Delete failed');
            }
          })}
        >
          <h3>Delete message</h3>
          <label>
            Message ID
            <input {...deleteForm.register('id')} />
          </label>
          <label>
            Tenant ID
            <input {...deleteForm.register('tenantId')} />
          </label>
          <button className="primary-button" type="submit">Delete</button>
        </form>
      </div>

      <hr style={{ opacity: 0.2 }} />
      <form className="form-grid" onSubmit={connectStream}>
        <h3>Realtime stream (SSE)</h3>
        <label>
          User email
          <input {...streamForm.register('userEmail')} />
        </label>
        <label>
          Partner email
          <input {...streamForm.register('partnerEmail')} />
        </label>
        <label>
          Token
          <input {...streamForm.register('token')} />
        </label>
        <button className="primary-button" type="submit">{streaming ? 'Reconnect' : 'Connect'}</button>
        <button
          className="primary-button"
          type="button"
          onClick={() => {
            eventSourceRef.current?.close();
            setStreaming(false);
          }}
        >
          Stop
        </button>
      </form>
      {latestEvent && (
        <pre className="code-block" style={{ maxHeight: 200 }}>{JSON.stringify(latestEvent.raw, null, 2)}</pre>
      )}
    </SectionCard>
  );
}
