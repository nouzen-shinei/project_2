import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionCard } from '../../components/SectionCard';
import {
  fetchGlobalSettings,
  updateGlobalSettings,
  type GlobalSettingsDoc,
} from '../../lib/apiClient';

type FormState = {
  supportEmail: string;
  supportPhone: string;
  whatsappNumber: string;
  bugReportFormUrl: string;
  coachingName: string;
  privacyPolicyUrl: string;
  termsOfServiceUrl: string;
};

function toFormState(doc: GlobalSettingsDoc | null): FormState {
  return {
    supportEmail: doc?.supportEmail ?? '',
    supportPhone: doc?.supportPhone ?? '',
    whatsappNumber: doc?.whatsappNumber ?? '',
    bugReportFormUrl: doc?.bugReportFormUrl ?? '',
    coachingName: doc?.coachingName ?? '',
    privacyPolicyUrl: doc?.legal?.privacyPolicyUrl ?? '',
    termsOfServiceUrl: doc?.legal?.termsOfServiceUrl ?? '',
  };
}

export function GlobalSettingsPanel() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverDoc, setServerDoc] = useState<GlobalSettingsDoc | null>(null);
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
      const response = await fetchGlobalSettings();
      const doc = response.data ?? null;
      setServerDoc(doc);
      setForm(toFormState(doc));
    } catch (err: any) {
      setError(err?.message || 'Failed to load global settings');
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
      const trimmed = (v: string) => v.trim();
      const patch: Partial<GlobalSettingsDoc> = {
        supportEmail: trimmed(form.supportEmail),
        supportPhone: trimmed(form.supportPhone),
        whatsappNumber: trimmed(form.whatsappNumber),
        bugReportFormUrl: trimmed(form.bugReportFormUrl),
        coachingName: trimmed(form.coachingName),
        legal: {
          privacyPolicyUrl: trimmed(form.privacyPolicyUrl),
          termsOfServiceUrl: trimmed(form.termsOfServiceUrl),
        },
      };
      // Drop empty top-level strings so we never blank a value unintentionally.
      (Object.keys(patch) as (keyof GlobalSettingsDoc)[]).forEach((key) => {
        if (typeof patch[key] === 'string' && (patch[key] as string) === '') {
          delete patch[key];
        }
      });
      if (patch.legal && !patch.legal.privacyPolicyUrl && !patch.legal.termsOfServiceUrl) {
        delete patch.legal;
      }

      const response = await updateGlobalSettings(patch);
      const updated = response.data ?? null;
      setServerDoc(updated);
      setForm(toFormState(updated));
    } catch (err: any) {
      setError(err?.message || 'Failed to save global settings');
    } finally {
      setSaving(false);
    }
  };

  const field = (key: keyof FormState) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      setForm((prev) => ({ ...prev, [key]: e.target.value })),
  });

  return (
    <SectionCard
      title="Global Settings"
      description="App-wide support contact, legal links, and default brand shown across every tenant. Per-tenant visibility policies are managed inside each coaching center's admin settings, not here."
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
          Support email
          <input type="email" placeholder="support@example.com" {...field('supportEmail')} />
        </label>
        <label>
          Support phone
          <input type="text" placeholder="+91…" {...field('supportPhone')} />
        </label>
        <label>
          WhatsApp number
          <input type="text" placeholder="+91…" {...field('whatsappNumber')} />
        </label>
        <label>
          Bug report form URL
          <input type="url" placeholder="https://…" {...field('bugReportFormUrl')} />
        </label>
        <label>
          Default brand name
          <input type="text" placeholder="e.g. S.S Tuition Classes" {...field('coachingName')} />
        </label>
        <label>
          Privacy policy URL
          <input type="url" placeholder="https://…" {...field('privacyPolicyUrl')} />
        </label>
        <label>
          Terms of service URL
          <input type="url" placeholder="https://…" {...field('termsOfServiceUrl')} />
        </label>
      </div>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginTop: '1rem' }}>
        {updatedAtLabel && <span className="muted">Last updated: {updatedAtLabel}</span>}
        {error && <span style={{ color: '#f87171' }}>{error}</span>}
      </div>
    </SectionCard>
  );
}
