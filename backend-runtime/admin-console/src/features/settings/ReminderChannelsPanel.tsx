import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionCard } from '../../components/SectionCard';
import {
  fetchReminderChannelsPolicy,
  updateReminderChannelsPolicy,
  type ReminderChannelsPolicyDoc,
  type ReminderChannelKey,
} from '../../lib/apiClient';

type FormState = {
  enabled: Record<ReminderChannelKey, boolean>;
  messages: Record<ReminderChannelKey, string>;
  hideDisabledReminderTypes: boolean;
};

function toFormState(doc: ReminderChannelsPolicyDoc | null): FormState {
  const enabled = (doc?.enabledChannels ?? {}) as Partial<Record<ReminderChannelKey, boolean>>;
  const msgs = (doc?.channelMessages ?? {}) as Partial<Record<ReminderChannelKey, string>>;
  return {
    enabled: {
      email: enabled.email !== false,
      sms: enabled.sms !== false,
      whatsapp: enabled.whatsapp !== false,
      voice: enabled.voice !== false,
    },
    messages: {
      email: msgs.email ?? '',
      sms: msgs.sms ?? '',
      whatsapp: msgs.whatsapp ?? '',
      voice: msgs.voice ?? '',
    },
    hideDisabledReminderTypes: Boolean(doc?.hideDisabledReminderTypes),
  };
}

export function ReminderChannelsPanel() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverDoc, setServerDoc] = useState<ReminderChannelsPolicyDoc | null>(null);
  const [form, setForm] = useState<FormState>(() => toFormState(null));

  const updatedAtLabel = useMemo(() => {
    if (!serverDoc?.updatedAt) return null;
    const ts = Date.parse(serverDoc.updatedAt);
    if (Number.isNaN(ts)) return serverDoc.updatedAt;
    return new Date(ts).toLocaleString();
  }, [serverDoc?.updatedAt]);

  const load = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const response = await fetchReminderChannelsPolicy();
      const doc = response.data ?? null;
      setServerDoc(doc);
      setForm(toFormState(doc));
    } catch (err: any) {
      setError(err?.message || 'Failed to load reminder channel policy');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      const patch: {
        enabledChannels: Partial<Record<ReminderChannelKey, boolean>>;
        channelMessages: Partial<Record<ReminderChannelKey, string>>;
        hideDisabledReminderTypes: boolean;
      } = {
        enabledChannels: {
          email: Boolean(form.enabled.email),
          sms: Boolean(form.enabled.sms),
          whatsapp: Boolean(form.enabled.whatsapp),
          voice: Boolean(form.enabled.voice),
        },
        channelMessages: {
          email: form.messages.email,
          sms: form.messages.sms,
          whatsapp: form.messages.whatsapp,
          voice: form.messages.voice,
        },
        hideDisabledReminderTypes: Boolean(form.hideDisabledReminderTypes),
      };

      const response = await updateReminderChannelsPolicy(patch);
      const updated = response.data ?? null;
      setServerDoc(updated);
      setForm(toFormState(updated));
    } catch (err: any) {
      setError(err?.message || 'Failed to save reminder channel policy');
    } finally {
      setSaving(false);
    }
  }, [
    form.enabled.email,
    form.enabled.sms,
    form.enabled.whatsapp,
    form.enabled.voice,
    form.messages.email,
    form.messages.sms,
    form.messages.whatsapp,
    form.messages.voice,
    form.hideDisabledReminderTypes,
  ]);

  return (
    <SectionCard
      title="Reminder Channels"
      description="Globally enable/disable reminder delivery channels. Tenant-level settings can further restrict these."
      headerExtra={
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button className="primary-button" type="button" onClick={load} disabled={loading || saving}>
            {loading ? 'Loading…' : 'Reload'}
          </button>
          <button className="primary-button" type="button" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <div className="form-grid">
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.4rem' }}>
          <input
            type="checkbox"
            checked={form.hideDisabledReminderTypes}
            onChange={(e) => setForm((prev) => ({ ...prev, hideDisabledReminderTypes: e.target.checked }))}
          />
          <span>
            Hide disabled reminder types in app
            <div className="muted small-text">
              If enabled, disabled channels are hidden instead of shown as disabled.
            </div>
          </span>
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.4rem' }}>
          <input
            type="checkbox"
            checked={form.enabled.email}
            onChange={(e) => setForm((prev) => ({ ...prev, enabled: { ...prev.enabled, email: e.target.checked } }))}
          />
          <span>
            Email
            <div className="muted small-text">Enable email reminders globally</div>
          </span>
        </label>

        <label>
          Email disabled message (optional)
          <input
            value={form.messages.email}
            onChange={(e) => setForm((prev) => ({ ...prev, messages: { ...prev.messages, email: e.target.value } }))}
            placeholder="Shown in the app when Email is disabled"
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.4rem' }}>
          <input
            type="checkbox"
            checked={form.enabled.sms}
            onChange={(e) => setForm((prev) => ({ ...prev, enabled: { ...prev.enabled, sms: e.target.checked } }))}
          />
          <span>
            SMS
            <div className="muted small-text">Enable SMS reminders globally</div>
          </span>
        </label>

        <label>
          SMS disabled message (optional)
          <input
            value={form.messages.sms}
            onChange={(e) => setForm((prev) => ({ ...prev, messages: { ...prev.messages, sms: e.target.value } }))}
            placeholder="Shown in the app when SMS is disabled"
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.4rem' }}>
          <input
            type="checkbox"
            checked={form.enabled.whatsapp}
            onChange={(e) => setForm((prev) => ({ ...prev, enabled: { ...prev.enabled, whatsapp: e.target.checked } }))}
          />
          <span>
            WhatsApp
            <div className="muted small-text">Enable WhatsApp reminders globally</div>
          </span>
        </label>

        <label>
          WhatsApp disabled message (optional)
          <input
            value={form.messages.whatsapp}
            onChange={(e) => setForm((prev) => ({ ...prev, messages: { ...prev.messages, whatsapp: e.target.value } }))}
            placeholder="Shown in the app when WhatsApp is disabled"
          />
        </label>

        <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginTop: '0.4rem' }}>
          <input
            type="checkbox"
            checked={form.enabled.voice}
            onChange={(e) => setForm((prev) => ({ ...prev, enabled: { ...prev.enabled, voice: e.target.checked } }))}
          />
          <span>
            Voice
            <div className="muted small-text">Enable voice call reminders globally</div>
          </span>
        </label>

        <label>
          Voice disabled message (optional)
          <input
            value={form.messages.voice}
            onChange={(e) => setForm((prev) => ({ ...prev, messages: { ...prev.messages, voice: e.target.value } }))}
            placeholder="Shown in the app when Voice is disabled"
          />
        </label>
      </div>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginTop: '1rem' }}>
        {updatedAtLabel && <span className="muted">Last updated: {updatedAtLabel}</span>}
        {error && <span style={{ color: '#f87171' }}>{error}</span>}
      </div>
    </SectionCard>
  );
}
