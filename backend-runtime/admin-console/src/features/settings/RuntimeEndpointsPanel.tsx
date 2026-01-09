import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionCard } from '../../components/SectionCard';
import { fetchRuntimeEndpoints, updateRuntimeEndpoints, type RuntimeEndpointsDoc } from '../../lib/apiClient';

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

type FormState = {
  apiBaseUrl: string;
  emailApiBaseUrl: string;
  notificationsApiBaseUrl: string;
  wabaApiBaseUrl: string;
  chatApiBaseUrl: string;
};

function toFormState(doc: RuntimeEndpointsDoc | null): FormState {
  return {
    apiBaseUrl: doc?.apiBaseUrl ?? '',
    emailApiBaseUrl: doc?.emailApiBaseUrl ?? '',
    notificationsApiBaseUrl: doc?.notificationsApiBaseUrl ?? '',
    wabaApiBaseUrl: doc?.wabaApiBaseUrl ?? '',
    chatApiBaseUrl: doc?.chatApiBaseUrl ?? '',
  };
}

export function RuntimeEndpointsPanel() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverDoc, setServerDoc] = useState<RuntimeEndpointsDoc | null>(null);
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
      const response = await fetchRuntimeEndpoints();
      const doc = response.data ?? null;
      setServerDoc(doc);
      setForm(toFormState(doc));
    } catch (err: any) {
      setError(err?.message || 'Failed to load runtime endpoints');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const patch: Partial<RuntimeEndpointsDoc> = {};

      const apiBaseUrl = normalizeUrl(form.apiBaseUrl);
      const emailApiBaseUrl = normalizeUrl(form.emailApiBaseUrl);
      const notificationsApiBaseUrl = normalizeUrl(form.notificationsApiBaseUrl);
      const wabaApiBaseUrl = normalizeUrl(form.wabaApiBaseUrl);
      const chatApiBaseUrl = normalizeUrl(form.chatApiBaseUrl);

      if (apiBaseUrl) patch.apiBaseUrl = apiBaseUrl;
      if (emailApiBaseUrl) patch.emailApiBaseUrl = emailApiBaseUrl;
      if (notificationsApiBaseUrl) patch.notificationsApiBaseUrl = notificationsApiBaseUrl;
      if (wabaApiBaseUrl) patch.wabaApiBaseUrl = wabaApiBaseUrl;
      if (chatApiBaseUrl) patch.chatApiBaseUrl = chatApiBaseUrl;

      const response = await updateRuntimeEndpoints(patch);
      const updated = response.data ?? null;
      setServerDoc(updated);
      setForm(toFormState(updated));
    } catch (err: any) {
      setError(err?.message || 'Failed to save runtime endpoints');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Runtime Endpoints"
      description="Edit the backend base URLs stored in Firestore (appSettings/runtimeEndpoints). Used by the mobile app and server-to-server calls."
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
        <label>
          API Base URL
          <input
            value={form.apiBaseUrl}
            onChange={(e) => setForm((prev) => ({ ...prev, apiBaseUrl: e.target.value }))}
            placeholder="https://your-whatsapp-backend.fly.dev"
          />
        </label>
        <label>
          Email API Base URL
          <input
            value={form.emailApiBaseUrl}
            onChange={(e) => setForm((prev) => ({ ...prev, emailApiBaseUrl: e.target.value }))}
            placeholder="https://my-email-backend.fly.dev"
          />
        </label>
        <label>
          Notifications API Base URL
          <input
            value={form.notificationsApiBaseUrl}
            onChange={(e) => setForm((prev) => ({ ...prev, notificationsApiBaseUrl: e.target.value }))}
            placeholder="https://notifications.example.com"
          />
        </label>
        <label>
          WABA API Base URL
          <input
            value={form.wabaApiBaseUrl}
            onChange={(e) => setForm((prev) => ({ ...prev, wabaApiBaseUrl: e.target.value }))}
            placeholder="https://your-whatsapp-backend.fly.dev"
          />
        </label>
        <label>
          Chat API Base URL
          <input
            value={form.chatApiBaseUrl}
            onChange={(e) => setForm((prev) => ({ ...prev, chatApiBaseUrl: e.target.value }))}
            placeholder="https://chat.example.com"
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
