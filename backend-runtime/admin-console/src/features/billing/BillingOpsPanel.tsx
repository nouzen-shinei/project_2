import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionCard } from '../../components/SectionCard';
import {
  fetchBillingMetricsSummary,
  fetchBillingBackfillRuns,
  fetchBillingBackfillSchedulerStatus,
  fetchBillingOpsEvents,
  triggerBillingBackfillForTenant,
  type BillingMetricsSummary,
  type BillingBackfillRunRecord,
  type BillingBackfillSchedulerStatus,
  type BillingOpsEventRecord,
} from '../../lib/apiClient';

type ManualBackfillForm = {
  tenantId: string;
  dryRun: boolean;
  maxPaymentsPerSubscription: string;
  jobLabel: string;
  verbose: boolean;
};

const DEFAULT_LIMIT = 50;

function formatIso(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '—';
  try {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleString();
  } catch {
    return raw;
  }
}

function coercePositiveInt(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.trunc(parsed);
}

function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function BillingOpsPanel() {
  const [opsEvents, setOpsEvents] = useState<BillingOpsEventRecord[]>([]);
  const [opsCursor, setOpsCursor] = useState<string | null>(null);
  const [opsLoading, setOpsLoading] = useState(false);

  const [runs, setRuns] = useState<BillingBackfillRunRecord[]>([]);
  const [runsCursor, setRunsCursor] = useState<string | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);

  const [schedulerStatus, setSchedulerStatus] = useState<BillingBackfillSchedulerStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);

  const [error, setError] = useState<string | null>(null);

  const [manualForm, setManualForm] = useState<ManualBackfillForm>({
    tenantId: '',
    dryRun: true,
    maxPaymentsPerSubscription: '200',
    jobLabel: 'admin-console',
    verbose: false,
  });
  const [manualRunning, setManualRunning] = useState(false);
  const [manualResult, setManualResult] = useState<any>(null);

  const [billingMetrics, setBillingMetrics] = useState<BillingMetricsSummary | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [metricsError, setMetricsError] = useState<string | null>(null);

  const reloadOps = useCallback(async () => {
    setError(null);
    setOpsLoading(true);
    try {
      const data = await fetchBillingOpsEvents({ limit: DEFAULT_LIMIT });
      setOpsEvents(data.items || []);
      setOpsCursor(data.nextCursor || null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load billing ops events');
    } finally {
      setOpsLoading(false);
    }
  }, []);

  const reloadRuns = useCallback(async () => {
    setError(null);
    setRunsLoading(true);
    try {
      const data = await fetchBillingBackfillRuns({ limit: DEFAULT_LIMIT });
      setRuns(data.items || []);
      setRunsCursor(data.nextCursor || null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load billing backfill runs');
    } finally {
      setRunsLoading(false);
    }
  }, []);

  const reloadStatus = useCallback(async () => {
    setError(null);
    setStatusLoading(true);
    try {
      const data = await fetchBillingBackfillSchedulerStatus();
      setSchedulerStatus(data.scheduler || null);
    } catch (err: any) {
      setError(err?.message || 'Failed to load scheduler status');
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const reloadMetrics = useCallback(async () => {
    setMetricsError(null);
    setMetricsLoading(true);
    try {
      const data = await fetchBillingMetricsSummary();
      setBillingMetrics(data);
    } catch (err: any) {
      setMetricsError(err?.message || 'Failed to load /metrics');
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadStatus();
    void reloadOps();
    void reloadRuns();
    void reloadMetrics();
  }, [reloadMetrics, reloadOps, reloadRuns, reloadStatus]);

  const billingMetricsSummary = useMemo(() => {
    const data = billingMetrics;
    const backfillAge = data?.backfill?.lastRunAgeSeconds;
    const backfillAgeDisplay =
      backfillAge === null || backfillAge === undefined
        ? 'No scheduler run yet'
        : `${formatSeconds(backfillAge)} ago`;

    const g = data?.gauges;
    const snippet = g
      ? [
          `billing_webhook_signature_failures_15m ${g.billing_webhook_signature_failures_15m}`,
          `billing_webhook_invalid_json_15m ${g.billing_webhook_invalid_json_15m}`,
          `billing_webhook_handler_failures_15m ${g.billing_webhook_handler_failures_15m}`,
          `billing_invoice_write_failures_15m ${g.billing_invoice_write_failures_15m}`,
          `billing_state_write_failures_15m ${g.billing_state_write_failures_15m}`,
          `billing_unknown_events_24h ${g.billing_unknown_events_24h}`,
        ].join('\n')
      : '';

    return {
      activeBillingAlerts: data?.activeAlerts || [],
      backfillAgeDisplay,
      snippet,
    };
  }, [billingMetrics]);

  const opsSummary = useMemo(() => {
    const total = opsEvents.length;
    const errors = opsEvents.filter((e) => e.severity === 'error').length;
    const warns = opsEvents.filter((e) => e.severity === 'warn').length;
    return { total, errors, warns };
  }, [opsEvents]);

  const handleManualRun = async () => {
    const tenantId = manualForm.tenantId.trim();
    if (!tenantId) {
      setError('Tenant ID is required for manual backfill.');
      return;
    }

    setError(null);
    setManualResult(null);
    setManualRunning(true);
    try {
      const maxPayments = coercePositiveInt(manualForm.maxPaymentsPerSubscription);
      const dryRun = manualForm.dryRun;
      const payload = {
        tenantId,
        maxPaymentsPerSubscription: maxPayments,
        dryRun,
        confirm: dryRun ? undefined : true,
        verbose: manualForm.verbose,
        jobLabel: manualForm.jobLabel.trim() || undefined,
      };
      const result = await triggerBillingBackfillForTenant(payload);
      setManualResult(result);
      await reloadRuns();
    } catch (err: any) {
      setError(err?.message || 'Manual backfill failed');
    } finally {
      setManualRunning(false);
    }
  };

  return (
    <>
      <SectionCard
        title="Billing Ops"
        description="View webhook failures, reconciliation runs, and trigger backfills for individual tenants."
        headerExtra={
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="primary-button" type="button" onClick={reloadStatus} disabled={statusLoading}>
              {statusLoading ? 'Refreshing…' : 'Refresh status'}
            </button>
            <button className="primary-button" type="button" onClick={reloadOps} disabled={opsLoading}>
              {opsLoading ? 'Refreshing…' : 'Refresh ops'}
            </button>
            <button className="primary-button" type="button" onClick={reloadRuns} disabled={runsLoading}>
              {runsLoading ? 'Refreshing…' : 'Refresh runs'}
            </button>
            <button className="primary-button" type="button" onClick={reloadMetrics} disabled={metricsLoading}>
              {metricsLoading ? 'Refreshing…' : 'Refresh metrics'}
            </button>
          </div>
        }
      >
        {error && <p style={{ color: '#f87171', marginTop: '0.75rem' }}>{error}</p>}

        <div style={{ marginTop: '1rem' }}>
          <h3>Billing metrics</h3>
          <p className="muted" style={{ marginTop: '0.35rem' }}>
            Live snapshot. Backfill age: {billingMetricsSummary.backfillAgeDisplay}.
          </p>
          {metricsError && <p style={{ color: '#f87171', marginTop: '0.75rem' }}>{metricsError}</p>}

          <div style={{ marginTop: '0.75rem' }}>
            <h4>Active billing alerts</h4>
            {billingMetricsSummary.activeBillingAlerts.length === 0 ? (
              <p className="muted" style={{ marginTop: '0.35rem' }}>
                {metricsLoading ? 'Loading…' : 'No active billing alerts.'}
              </p>
            ) : (
              <ul style={{ marginTop: '0.35rem' }}>
                {billingMetricsSummary.activeBillingAlerts.map((name) => (
                  <li key={name} style={{ color: '#f87171' }}>
                    {name}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            <h4>Key gauges</h4>
            <pre className="code-block" style={{ marginTop: '0.5rem' }}>
              {billingMetricsSummary.snippet || (metricsLoading ? 'Loading…' : 'No billing gauges found.')}
            </pre>
          </div>
        </div>

        <div style={{ marginTop: '1rem' }}>
          <h3>Backfill scheduler</h3>
          <p className="muted" style={{ marginTop: '0.35rem' }}>
            Controlled by env vars. This view is read-only.
          </p>
          <div className="form-grid" style={{ marginTop: '0.75rem' }}>
            <label>
              Enabled
              <input value={schedulerStatus?.enabled ? 'Yes' : 'No'} readOnly />
            </label>
            <label>
              Interval (ms)
              <input value={schedulerStatus?.intervalMs ?? '—'} readOnly />
            </label>
            <label>
              Next run
              <input value={schedulerStatus?.nextRunAt ? formatIso(schedulerStatus.nextRunAt) : '—'} readOnly />
            </label>
            <label>
              Last run
              <input value={schedulerStatus?.lastRunAt ? formatIso(schedulerStatus.lastRunAt) : '—'} readOnly />
            </label>
            <label>
              Running
              <input value={schedulerStatus?.isRunning ? 'Yes' : 'No'} readOnly />
            </label>
          </div>
        </div>

        <div style={{ marginTop: '1.25rem' }}>
          <h3>Manual backfill</h3>
          <p className="muted" style={{ marginTop: '0.35rem' }}>
            Runs `POST /billing/admin/backfill` for one tenant. Use dry-run first.
          </p>
          <div className="form-grid" style={{ marginTop: '0.75rem' }}>
            <label>
              Tenant ID
              <input
                value={manualForm.tenantId}
                onChange={(e) => setManualForm((s) => ({ ...s, tenantId: e.target.value }))}
                placeholder="tenant_abc123"
              />
            </label>
            <label>
              Max payments per subscription
              <input
                value={manualForm.maxPaymentsPerSubscription}
                onChange={(e) => setManualForm((s) => ({ ...s, maxPaymentsPerSubscription: e.target.value }))}
                placeholder="200"
              />
              <span className="muted small-text">Higher values can be slower.</span>
            </label>
            <label>
              Job label
              <input
                value={manualForm.jobLabel}
                onChange={(e) => setManualForm((s) => ({ ...s, jobLabel: e.target.value }))}
                placeholder="admin-console"
              />
            </label>
            <label>
              Options
              <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.35rem' }}>
                <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={manualForm.dryRun}
                    onChange={(e) => setManualForm((s) => ({ ...s, dryRun: e.target.checked }))}
                  />
                  Dry run
                </label>
                <label style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
                  <input
                    type="checkbox"
                    checked={manualForm.verbose}
                    onChange={(e) => setManualForm((s) => ({ ...s, verbose: e.target.checked }))}
                  />
                  Verbose
                </label>
              </div>
              <span className="muted small-text">
                Turning off dry-run will write changes (sends `confirm=true`).
              </span>
            </label>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem', flexWrap: 'wrap' }}>
            <button className="primary-button" type="button" onClick={handleManualRun} disabled={manualRunning}>
              {manualRunning ? 'Running…' : manualForm.dryRun ? 'Run dry-run backfill' : 'Run backfill (write)'}
            </button>
          </div>

          {manualResult && (
            <div style={{ marginTop: '0.75rem' }}>
              <h4>Result</h4>
              <pre className="code-block" style={{ marginTop: '0.5rem' }}>{JSON.stringify(manualResult, null, 2)}</pre>
            </div>
          )}
        </div>

        <div style={{ marginTop: '1.25rem' }}>
          <h3>Ops events</h3>
          <p className="muted" style={{ marginTop: '0.35rem' }}>
            Recent billing incidents. Total: {opsSummary.total} · Errors: {opsSummary.errors} · Warnings: {opsSummary.warns}
          </p>
          <div style={{ marginTop: '0.75rem', overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Severity</th>
                  <th>Type</th>
                  <th>Tenant</th>
                  <th>Event</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {opsEvents.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="muted">
                      {opsLoading ? 'Loading…' : 'No ops events found.'}
                    </td>
                  </tr>
                ) : (
                  opsEvents.map((entry) => (
                    <tr key={entry.id}>
                      <td>{formatIso(entry.createdAtIso)}</td>
                      <td>{entry.severity || '—'}</td>
                      <td>{entry.type || '—'}</td>
                      <td>{entry.tenantId || '—'}</td>
                      <td>{entry.event || '—'}</td>
                      <td>{entry.message || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {opsCursor && (
            <p className="muted small-text" style={{ marginTop: '0.5rem' }}>
              Next cursor: {opsCursor}
            </p>
          )}
        </div>

        <div style={{ marginTop: '1.25rem' }}>
          <h3>Backfill runs</h3>
          <p className="muted" style={{ marginTop: '0.35rem' }}>
            Recent reconciliation executions (manual + scheduled).
          </p>
          <div style={{ marginTop: '0.75rem', overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Status</th>
                  <th>Dry run</th>
                  <th>Tenants</th>
                  <th>Invoices</th>
                  <th>Reconcile</th>
                  <th>Errors</th>
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="muted">
                      {runsLoading ? 'Loading…' : 'No backfill runs found.'}
                    </td>
                  </tr>
                ) : (
                  runs.map((entry) => (
                    <tr key={entry.id}>
                      <td>{formatIso(entry.startedAtIso)}</td>
                      <td>{entry.status || '—'}</td>
                      <td>{entry.dryRun ? 'Yes' : 'No'}</td>
                      <td>{entry.stats?.tenantsProcessed ?? '—'}</td>
                      <td>{entry.stats?.invoicesUpserted ?? '—'}</td>
                      <td>
                        {entry.stats?.reconciliation
                          ? `${entry.stats.reconciliation.providerCapturedPayments ?? 0} captured / ${entry.stats.reconciliation.firestorePaidInvoices ?? 0} paid · missing ${entry.stats.reconciliation.missingPaidInvoices ?? 0} · extra ${entry.stats.reconciliation.extraPaidInvoices ?? 0}`
                          : '—'}
                      </td>
                      <td>{entry.stats?.errors ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {runsCursor && (
            <p className="muted small-text" style={{ marginTop: '0.5rem' }}>
              Next cursor: {runsCursor}
            </p>
          )}
        </div>
      </SectionCard>
    </>
  );
}
