import { useEffect, useState } from 'react';
import { Clock, X } from 'lucide-react';
import { ApiError, fetchDeviceTimeline, type AuditEntryRecord } from '../../lib/apiClient';
import {
  describeActor,
  formatActionLabel,
  formatAuditTimestamp,
} from './deviceAudit';

interface DeviceTimelinePanelProps {
  tenantId: string;
  /** Owner email; the timeline endpoint keys off it, so it is required to load. */
  email: string;
  deviceId: string;
  /** Human-readable device label for the modal header. */
  deviceLabel?: string;
  onClose: () => void;
}

/**
 * A single device's activity timeline (Requirement 19). Entries come back
 * oldest-first (with a stable tie-break for equal action times) from
 * `fetchDeviceTimeline` and are rendered in that order. Each entry shows the
 * action type, the action time, and the acting administrator; when an entry has
 * no recorded actor it shows an "unattributed" indication (Requirements 19.2,
 * 19.3). A device with no recorded actions shows an empty-state (Requirement
 * 19.5).
 *
 * Rendered as a modal opened from a device's detail view, keyed by the target
 * device id + owner email.
 */
export function DeviceTimelinePanel({
  tenantId,
  email,
  deviceId,
  deviceLabel,
  onClose,
}: DeviceTimelinePanelProps) {
  const [entries, setEntries] = useState<AuditEntryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      // The timeline is keyed by owner email; without one it cannot be fetched.
      setLoaded(true);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDeviceTimeline({ tenantId, email: trimmedEmail, deviceId })
      .then((response) => {
        if (cancelled) return;
        setEntries(response.entries || []);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError(`The activity timeline could not be loaded (${err.status}).`);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('The activity timeline could not be loaded.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, email, deviceId]);

  const noOwnerEmail = email.trim().length === 0;
  const isEmpty = loaded && !error && !noOwnerEmail && entries.length === 0;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Device activity timeline"
      onClick={onClose}
    >
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2 className="modal-title">
            <Clock size={18} /> Activity timeline
          </h2>
          <button type="button" className="text-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="modal-body">
          <p className="muted small-text" style={{ overflowWrap: 'anywhere' }}>
            {deviceLabel ? `${deviceLabel} · ` : ''}
            {deviceId}
          </p>

          {noOwnerEmail ? (
            <p className="muted">
              This device has no owner email, so its activity timeline cannot be loaded.
            </p>
          ) : error ? (
            <div className="tenant-error" role="alert">
              {error}
            </div>
          ) : loading ? (
            <p className="muted">Loading timeline…</p>
          ) : isEmpty ? (
            // Requirement 19.5: no recorded actions.
            <p className="muted">No actions have been recorded for this device.</p>
          ) : (
            <ol className="audit-list audit-timeline">
              {entries.map((entry) => {
                const actor = describeActor(entry);
                const timestamp = formatAuditTimestamp(entry);
                return (
                  <li className="audit-entry" key={entry.id}>
                    <div className="audit-entry__head">
                      <span className="badge">{formatActionLabel(entry.action)}</span>
                      {timestamp && <span className="muted small-text">{timestamp}</span>}
                    </div>
                    <div className="audit-entry__body">
                      <span
                        className={
                          actor.attributed ? 'audit-entry__actor' : 'audit-entry__actor muted'
                        }
                      >
                        {actor.label}
                      </span>
                      {entry.reason?.trim() && (
                        <span className="small-text" style={{ overflowWrap: 'anywhere' }}>
                          Reason: {entry.reason.trim()}
                        </span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <footer className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
