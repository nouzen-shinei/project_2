import { useMemo, useState } from 'react';
import { SectionCard } from '../../components/SectionCard';
import {
  ApiError,
  fetchGlobalAdminClaim,
  fetchGlobalAdminMe,
  updateGlobalAdminClaim,
  type GlobalAdminLookupResult,
  type GlobalAdminMe,
} from '../../lib/apiClient';

export function GlobalAdminClaimsPanel() {
  const [uid, setUid] = useState('');
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [me, setMe] = useState<GlobalAdminMe | null>(null);
  const [lookupResult, setLookupResult] = useState<GlobalAdminLookupResult | null>(null);
  const [loadingMe, setLoadingMe] = useState(false);
  const [loadingLookup, setLoadingLookup] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const lookupPayload = useMemo(() => {
    const normalizedUid = uid.trim();
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedUid && !normalizedEmail) return null;
    return {
      ...(normalizedUid ? { uid: normalizedUid } : {}),
      ...(normalizedEmail ? { email: normalizedEmail } : {}),
    };
  }, [uid, email]);

  const resolveErrorMessage = (err: unknown, fallback: string) => {
    if (err instanceof ApiError) {
      if (err.status === 403) {
        return 'Not authorized for this operation. Use master key for claim updates.';
      }
      if (err.status === 404) {
        return 'User not found.';
      }
      return err.message || fallback;
    }
    if (err instanceof Error && err.message) {
      return err.message;
    }
    return fallback;
  };

  const loadMe = async () => {
    setError(null);
    setSuccess(null);
    setLoadingMe(true);
    try {
      const response = await fetchGlobalAdminMe();
      setMe(response);
      setSuccess('Loaded caller global-admin status.');
    } catch (err) {
      setError(resolveErrorMessage(err, 'Failed to load current admin-claim status.'));
    } finally {
      setLoadingMe(false);
    }
  };

  const runLookup = async () => {
    if (!lookupPayload) {
      setError('Enter either UID or email to look up claims.');
      return;
    }
    setError(null);
    setSuccess(null);
    setLoadingLookup(true);
    try {
      const result = await fetchGlobalAdminClaim(lookupPayload);
      setLookupResult(result);
      setSuccess('Loaded target user claim state.');
    } catch (err) {
      setError(resolveErrorMessage(err, 'Failed to load target claim state.'));
    } finally {
      setLoadingLookup(false);
    }
  };

  const applyClaim = async (admin: boolean) => {
    if (!lookupPayload) {
      setError('Enter either UID or email before updating claims.');
      return;
    }

    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const result = await updateGlobalAdminClaim({
        ...lookupPayload,
        admin,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setSuccess(
        result.changed
          ? `Updated admin claim for ${result.email || result.uid} to ${result.admin ? 'true' : 'false'}.`
          : 'No change: claim already in requested state.'
      );
      const refreshed = await fetchGlobalAdminClaim(lookupPayload);
      setLookupResult(refreshed);
    } catch (err) {
      setError(resolveErrorMessage(err, 'Failed to update admin claim.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      title="Global Admin Claims"
      description="Inspect and manage Firebase custom admin claims. Read endpoints support global admins; claim updates require master auth."
      headerExtra={
        <button className="primary-button" type="button" onClick={loadMe} disabled={loadingMe || saving || loadingLookup}>
          {loadingMe ? 'Checking…' : 'Check My Status'}
        </button>
      }
    >
      <div className="form-grid">
        <label>
          Target UID (optional)
          <input value={uid} onChange={(e) => setUid(e.target.value)} placeholder="firebase_uid" />
        </label>
        <label>
          Target Email (optional)
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="user@example.com" />
        </label>
        <label>
          Change reason (optional)
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Operational escalation" />
        </label>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
        <button className="primary-button" type="button" onClick={runLookup} disabled={loadingLookup || saving}>
          {loadingLookup ? 'Looking up…' : 'Lookup Claim'}
        </button>
        <button className="primary-button" type="button" onClick={() => applyClaim(true)} disabled={saving || loadingLookup}>
          {saving ? 'Saving…' : 'Grant Admin'}
        </button>
        <button className="primary-button" type="button" onClick={() => applyClaim(false)} disabled={saving || loadingLookup}>
          {saving ? 'Saving…' : 'Revoke Admin'}
        </button>
      </div>

      {me && (
        <div style={{ marginTop: '1rem' }}>
          <p className="muted" style={{ marginBottom: '0.25rem' }}>Current caller</p>
          <pre>{JSON.stringify(me, null, 2)}</pre>
        </div>
      )}

      {lookupResult && (
        <div style={{ marginTop: '1rem' }}>
          <p className="muted" style={{ marginBottom: '0.25rem' }}>Target claim state</p>
          <pre>{JSON.stringify(lookupResult, null, 2)}</pre>
        </div>
      )}

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginTop: '1rem' }}>
        {success && <span style={{ color: '#34d399' }}>{success}</span>}
        {error && <span style={{ color: '#f87171' }}>{error}</span>}
      </div>
    </SectionCard>
  );
}
