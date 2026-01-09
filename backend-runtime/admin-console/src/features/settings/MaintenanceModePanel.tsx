import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionCard } from '../../components/SectionCard';
import {
  fetchMaintenanceMode,
  updateMaintenanceMode,
  type MaintenanceModeDoc,
} from '../../lib/apiClient';

type FormState = {
  enabled: boolean;
  message: string;
};

function toFormState(doc: MaintenanceModeDoc | null): FormState {
  return {
    enabled: Boolean(doc?.enabled),
    message: doc?.message ?? '',
  };
}

export function MaintenanceModePanel() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverDoc, setServerDoc] = useState<MaintenanceModeDoc | null>(null);
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
      const response = await fetchMaintenanceMode();
      const doc = response.data ?? null;
      setServerDoc(doc);
      setForm(toFormState(doc));
    } catch (err: any) {
      setError(err?.message || 'Failed to load maintenance mode');
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
      const patch: Partial<MaintenanceModeDoc> = {
        enabled: Boolean(form.enabled),
        message: form.message,
      };

      const response = await updateMaintenanceMode(patch);
      const updated = response.data ?? null;
      setServerDoc(updated);
      setForm(toFormState(updated));
    } catch (err: any) {
      setError(err?.message || 'Failed to save maintenance mode');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Maintenance Mode"
      description="When enabled, the mobile/web app will show a blocking maintenance screen and prevent usage."
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
            checked={form.enabled}
            onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
          />
          Enable maintenance mode
        </label>

        <label>
          Message (optional)
          <textarea
            value={form.message}
            onChange={(e) => setForm((prev) => ({ ...prev, message: e.target.value }))}
            placeholder="We are currently performing maintenance. Please try again shortly."
            rows={4}
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
