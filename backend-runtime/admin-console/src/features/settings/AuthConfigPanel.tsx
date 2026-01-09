import { useEffect, useState } from 'react';
import { SectionCard } from '../../components/SectionCard';
import { issueInternalToken } from '../../lib/apiClient';
import { useConfigStore } from '../../store/configStore';

export function AuthConfigPanel() {
  const {
    baseUrl,
    masterKey,
    bearerToken,
    rememberSecret,
    lastIssuedTokenExpiry,
    setBaseUrl,
    setMasterKey,
    setBearerToken,
    setRememberSecret,
    resetState,
  } = useConfigStore();
  const [issuing, setIssuing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const hasToken = Boolean(bearerToken);
  const expiryTimestamp = lastIssuedTokenExpiry ?? null;
  const isTokenExpired = Boolean(expiryTimestamp && expiryTimestamp <= now);
  const badgeClass = isTokenExpired ? 'badge offline' : 'badge online';
  const badgeLabel = isTokenExpired ? 'Token expired' : 'Token active';

  useEffect(() => {
    if (hasToken && isTokenExpired) {
      setBearerToken('', expiryTimestamp ?? undefined);
    }
  }, [expiryTimestamp, hasToken, isTokenExpired, setBearerToken]);

  const handleIssue = async () => {
    setError(null);
    setIssuing(true);
    try {
      const response = await issueInternalToken();
      setBearerToken(response.token, response.expiresAt);
    } catch (err: any) {
      setError(err?.message || 'Failed to issue token');
    } finally {
      setIssuing(false);
    }
  };

  return (
    <SectionCard
      title="Connection & Auth"
      description="Store the backend base URL, master key, and mint short-lived internal tokens for Console requests."
      headerExtra={
        <button className="primary-button" type="button" onClick={resetState}>
          Reset
        </button>
      }
    >
      <div className="form-grid">
        <label>
          Base URL
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://backend.example.com"
          />
        </label>
        <label>
          Master Key (INTERNAL_API_KEY)
          <input
            value={masterKey}
            onChange={(e) => setMasterKey(e.target.value)}
            type="password"
            placeholder="secret"
          />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
          <input
            type="checkbox"
            checked={rememberSecret}
            onChange={(e) => setRememberSecret(e.target.checked)}
          />
          Persist master key in this browser
        </label>
      </div>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
        <button className="primary-button" onClick={handleIssue} disabled={issuing || !masterKey}>
          {issuing ? 'Issuing…' : 'Issue Internal Token'}
        </button>
        {(hasToken || (expiryTimestamp && isTokenExpired)) && <span className={badgeClass}>{badgeLabel}</span>}
        {expiryTimestamp && (
          <span className="muted">
            Expires {new Date(expiryTimestamp).toLocaleString()}
            {isTokenExpired ? ' (expired)' : ''}
          </span>
        )}
        {error && <span style={{ color: '#f87171' }}>{error}</span>}
      </div>
    </SectionCard>
  );
}
