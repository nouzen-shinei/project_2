import { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { SectionCard } from '../../components/SectionCard';
import { deleteChatMessage, editChatMessage, fetchChatDelta, sendChatMessage } from '../../lib/apiClient';
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

interface ChatEvent {
  id: string;
  raw: unknown;
}

export function ChatPanel() {
  const deltaForm = useForm<DeltaForm>({ resolver: zodResolver(deltaSchema) });
  const sendForm = useForm<SendForm>({ resolver: zodResolver(sendSchema) });
  const editForm = useForm<EditForm>({ resolver: zodResolver(editSchema) });
  const deleteForm = useForm<DeleteForm>({ resolver: zodResolver(deleteSchema) });
  const streamForm = useForm<StreamForm>({ resolver: zodResolver(streamSchema), defaultValues: { token: useConfigStore.getState().bearerToken } });
  const [deltaResult, setDeltaResult] = useState<unknown>(null);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const deltaString = useMemo(() => (deltaResult ? JSON.stringify(deltaResult, null, 2) : null), [deltaResult]);

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
