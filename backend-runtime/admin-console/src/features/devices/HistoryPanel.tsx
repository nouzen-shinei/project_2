import { useCallback, useEffect, useRef, useState } from 'react';
import { History, RefreshCcw } from 'lucide-react';
import { ApiError, fetchDeviceHistory, type AuditEntryRecord } from '../../lib/apiClient';
import {
  describeActor,
  describeTarget,
  formatActionLabel,
  formatAuditTimestamp,
} from './deviceAudit';

/** Page size for each history fetch (cursor pagination). */
const HISTORY_PAGE_SIZE = 25;

interface HistoryPanelProps {
  tenantId: string;
}

/**
 * Tenant-scoped action + notification history (Requirements 13, 17.5). Entries
 * come back most-recent-first from `fetchDeviceHistory` and are rendered in that
 * order; a cursor-driven "Load more" appends the next page. Each entry is
 * attributed to its acting administrator (name/email), with an "unattributed"
 * indication when none is recorded (Requirement 13.2).
 *
 * All-or-nothing on error (Requirements 13.4, 13.5): a failed fetch surfaces only
 * an error indication and never renders partial rows. A first-page failure shows
 * the error with no rows; a "Load more" failure retains the already-loaded pages
 * and shows the error for the failed fetch without appending anything.
 */
export function HistoryPanel({ tenantId }: HistoryPanelProps) {
  const [entries, setEntries] = useState<AuditEntryRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  const requestIdRef = useRef(0);

  const describeError = (err: unknown): string => {
    if (err instanceof ApiError) return `History could not be loaded (${err.status}).`;
    if (err instanceof Error) return err.message;
    return 'History could not be loaded for this tenant.';
  };

  const loadFirstPage = useCallback(async () => {
    if (!tenantId) return;
    const requestId = (requestIdRef.current += 1);
    setLoading(true);
    setError(null);
    try {
      const response = await fetchDeviceHistory({ tenantId, limit: HISTORY_PAGE_SIZE });
      if (requestIdRef.current !== requestId) return;
      // All-or-nothing: only commit the full page on success.
      setEntries(response.entries || []);
      setHasMore(Boolean(response.hasMore));
      setNextCursor(response.nextCursor);
      setHasLoaded(true);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      // Requirement 13.5: never show partial rows for a failed fetch.
      setEntries([]);
      setHasMore(false);
      setNextCursor(undefined);
      setError(describeError(err));
      setHasLoaded(true);
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [tenantId]);

  const loadMore = useCallback(async () => {
    if (!tenantId || !nextCursor || loadingMore) return;
    const requestId = requestIdRef.current;
    setLoadingMore(true);
    setError(null);
    try {
      const response = await fetchDeviceHistory({
        tenantId,
        limit: HISTORY_PAGE_SIZE,
        cursor: nextCursor,
      });
      if (requestIdRef.current !== requestId) return;
      // Append the fully-loaded next page; the retained pages stay intact.
      setEntries((prev) => [...prev, ...(response.entries || [])]);
      setHasMore(Boolean(response.hasMore));
      setNextCursor(response.nextCursor);
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      // Requirement 13.5: retain already-loaded pages, surface only the error,
      // and append nothing from the failed fetch.
      setError(describeError(err));
    } finally {
      if (requestIdRef.current === requestId) setLoadingMore(false);
    }
  }, [tenantId, nextCursor, loadingMore]);

  // Load / reload when the scoped tenant changes.
  useEffect(() => {
    setEntries([]);
    setHasMore(false);
    setNextCursor(undefined);
    setHasLoaded(false);
    void loadFirstPage();
  }, [loadFirstPage]);

  const initialLoading = loading && !hasLoaded;
  const isEmpty = hasLoaded && !error && entries.length === 0;

  return (
    <div className="history-panel">
      <div className="history-panel__header">
        <h3 className="history-panel__title">
          <History size={16} /> Action &amp; notification history
        </h3>
        <button
          type="button"
          className="text-button"
          onClick={() => void loadFirstPage()}
          disabled={loading}
        >
          <RefreshCcw size={14} /> {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <p className="muted small-text">
        Actions and notifications recorded for this tenant, most recent first.
      </p>

      {error && (
        <div className="tenant-error" role="alert">
          <strong>History could not be loaded.</strong> {error}
          {entries.length > 0 ? ' Showing the previously loaded records.' : ''}
        </div>
      )}

      {initialLoading ? (
        <p className="muted">Loading history…</p>
      ) : isEmpty ? (
        // Requirements 13.3, 17.6: empty-history indication.
        <p className="muted">No history records exist for this tenant.</p>
      ) : entries.length > 0 ? (
        <>
          <ul className="audit-list">
            {entries.map((entry) => {
              const actor = describeActor(entry);
              const target = describeTarget(entry);
              const timestamp = formatAuditTimestamp(entry);
              return (
                <li className="audit-entry" key={entry.id}>
                  <div className="audit-entry__head">
                    <span className="badge">{formatActionLabel(entry.action)}</span>
                    {timestamp && <span className="muted small-text">{timestamp}</span>}
                  </div>
                  <div className="audit-entry__body">
                    <span
                      className={actor.attributed ? 'audit-entry__actor' : 'audit-entry__actor muted'}
                    >
                      {actor.label}
                    </span>
                    {target && (
                      <span className="muted small-text" style={{ overflowWrap: 'anywhere' }}>
                        Target: {target}
                      </span>
                    )}
                    {entry.reason?.trim() && (
                      <span className="small-text" style={{ overflowWrap: 'anywhere' }}>
                        Reason: {entry.reason.trim()}
                      </span>
                    )}
                    {typeof entry.affectedCount === 'number' && (
                      <span className="muted small-text">Affected devices: {entry.affectedCount}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          {hasMore && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              style={{ alignSelf: 'flex-start' }}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </>
      ) : null}
    </div>
  );
}
