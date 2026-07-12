import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Bell, CheckSquare, LogOut, Square, X } from 'lucide-react';
import {
  bulkForceLogoutDevices,
  type BulkForceLogoutResponse,
  type DeviceAdminRecord,
  type DeviceTarget,
} from '../../lib/apiClient';
import { NotificationComposer } from './NotificationComposer';
import { DeviceActionsMenu, describeDeviceApiError, REASON_MAX_LENGTH } from './DeviceActionsMenu';

/** A single bulk notify / force-logout action targets at most 500 devices (Requirement 14.2). */
export const MAX_BULK_TARGETS = 500;

/** Aligned `DeviceTarget` + readable-label lists for a set of selected devices. */
export interface SelectionTargets {
  targets: DeviceTarget[];
  labels: string[];
}

/**
 * Build the aligned `DeviceTarget` + human-readable label lists for the selected
 * devices that can actually be addressed by a bulk action — those with an owner
 * email. A Device with no owner email cannot be a notify / force-logout target
 * (the API keys delivery + signals on `{ email, deviceId }`), so it is omitted
 * from the request payload while still counting toward the raw selection.
 */
export function buildSelectionTargets(devices: DeviceAdminRecord[]): SelectionTargets {
  const targets: DeviceTarget[] = [];
  const labels: string[] = [];
  for (const device of devices) {
    const email = (device.ownerEmail ?? '').trim();
    if (!email) continue;
    targets.push({ email, deviceId: device.deviceId });
    const name = device.deviceName?.trim();
    labels.push(name ? `${name} · ${email}` : `${device.deviceId} · ${email}`);
  }
  return { targets, labels };
}

interface BulkForceLogoutDialogProps {
  tenantId: string;
  targets: DeviceTarget[];
  onClose: () => void;
  onComplete: (result: BulkForceLogoutResponse) => void;
}

/**
 * Confirmation dialog for bulk force-logout. Carries an optional shared reason
 * and fans the action out to every selected target via `bulkForceLogoutDevices`;
 * the endpoint continues past per-target failures and returns per-target
 * outcomes (Requirement 14.7), which the caller surfaces as a summary
 * (Requirement 14.8).
 */
function BulkForceLogoutDialog({ tenantId, targets, onClose, onComplete }: BulkForceLogoutDialogProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const count = targets.length;
  const trimmedReason = reason.trim();

  const handleSubmit = async () => {
    if (submitting || count === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await bulkForceLogoutDevices({
        tenantId,
        targets,
        reason: trimmedReason || undefined,
      });
      onComplete(result);
    } catch (err) {
      setError(describeDeviceApiError(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Force logout selected devices"
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div className="modal-card modal-card--sm" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2 className="modal-title">
            <AlertTriangle size={18} color="#f87171" /> Force logout {count} device{count === 1 ? '' : 's'}
          </h2>
          <button type="button" className="text-button" onClick={onClose} disabled={submitting} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="modal-body">
          <p className="muted" style={{ margin: 0 }}>
            Each selected device will be signed out on its next check-in. This applies to every device
            in the current selection that is associated with this tenant.
          </p>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <span>Reason (optional)</span>
            <textarea
              className="textarea"
              value={reason}
              maxLength={REASON_MAX_LENGTH}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Optional reason applied to every selected device…"
              disabled={submitting}
            />
            <span className="char-count">
              {trimmedReason.length}/{REASON_MAX_LENGTH}
            </span>
          </label>

          {error && (
            <div className="tenant-error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="button" className="danger-button" onClick={handleSubmit} disabled={submitting || count === 0}>
            <LogOut size={14} /> {submitting ? 'Working…' : `Force logout ${count}`}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface SelectionBarProps {
  tenantId: string;
  /**
   * The currently selected device records, in display order. The selection
   * `Set<deviceId>` lives in `DeviceConsolePanel`, which resolves it to records
   * and prunes newly-ineligible ids on every list reload (Requirement 14.5), so
   * this list only ever contains still-selectable devices.
   */
  selectedDevices: DeviceAdminRecord[];
  /** Count of selectable devices in the current view (drives the select-all control). */
  selectableCount: number;
  /** Whether every selectable device in the current view is already selected. */
  allSelectableSelected: boolean;
  /**
   * The most recent bulk force-logout summary. Owned by the panel so it survives
   * the selection being pruned to empty once the affected devices become
   * logged-out (Requirement 14.8); `null` hides the summary.
   */
  bulkSummary: BulkForceLogoutResponse | null;
  onSelectAllSelectable: () => void;
  onClearSelection: () => void;
  /** Called with the bulk force-logout response so the panel can persist + refresh. */
  onBulkForceLogoutComplete: (result: BulkForceLogoutResponse) => void;
  onDismissSummary: () => void;
  /** Reload the device list (which re-prunes the selection) after a single-device action. */
  onActionComplete: () => void;
}

/**
 * Selection + bulk-action bar (task 13.4, Requirement 14). Rendered by
 * `DeviceConsolePanel` whenever at least one device is selected (or a bulk
 * summary is pending). Offers:
 *
 * - Select-all-selectable / clear-selection controls (Requirement 14.1). Only
 *   Selectable_Devices (not deleted, not hard banned, not logged out) are ever
 *   selectable, so the panel renders a per-row checkbox only for those.
 * - Bulk NOTIFY (reuses {@link NotificationComposer} with the selected targets)
 *   and bulk FORCE-LOGOUT (wired to `bulkForceLogoutDevices`), each capped at
 *   500 targets (Requirement 14.2) — both are disabled and the cap is surfaced
 *   when the selection exceeds the cap.
 * - Single-device gating (Requirements 14.3, 14.6): ban / delete /
 *   permanent-delete (plus single force logout) are offered only when exactly
 *   one device is selected, delegated to {@link DeviceActionsMenu}. With more
 *   than one selected, only the bulk notify + bulk force-logout actions appear.
 * - A success/failure summary for the completed bulk force-logout
 *   (Requirement 14.8); the notify summary is shown inline by the composer.
 */
export function SelectionBar({
  tenantId,
  selectedDevices,
  selectableCount,
  allSelectableSelected,
  bulkSummary,
  onSelectAllSelectable,
  onClearSelection,
  onBulkForceLogoutComplete,
  onDismissSummary,
  onActionComplete,
}: SelectionBarProps) {
  const [showComposer, setShowComposer] = useState(false);
  const [showForceLogout, setShowForceLogout] = useState(false);

  const selectedCount = selectedDevices.length;
  const singleSelected = selectedCount === 1;

  const { targets, labels } = useMemo(() => buildSelectionTargets(selectedDevices), [selectedDevices]);
  const targetableCount = targets.length;
  const overCap = targetableCount > MAX_BULK_TARGETS;
  const canBulk = targetableCount > 0 && !overCap;
  const untargetable = selectedCount - targetableCount;

  const failedForceLogout = bulkSummary?.results?.filter((entry) => !entry.ok) ?? [];

  const handleForceLogoutComplete = (result: BulkForceLogoutResponse) => {
    setShowForceLogout(false);
    onBulkForceLogoutComplete(result);
  };

  // Defensive: with no selection and no pending summary the panel would not
  // mount this bar, but guard so an empty bar never renders.
  if (selectedCount === 0 && !bulkSummary) return null;

  return (
    <div className="selection-bar" role="region" aria-label="Device selection actions">
      <div className="selection-bar__row">
        <span className="selection-bar__summary">
          <strong>{selectedCount}</strong> device{selectedCount === 1 ? '' : 's'} selected
        </span>
        <div className="selection-bar__controls">
          <button
            type="button"
            className="secondary-button"
            onClick={onSelectAllSelectable}
            disabled={selectableCount === 0 || allSelectableSelected}
          >
            <CheckSquare size={14} /> Select all selectable{selectableCount > 0 ? ` (${selectableCount})` : ''}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={onClearSelection}
            disabled={selectedCount === 0}
          >
            <Square size={14} /> Clear selection
          </button>
        </div>
      </div>

      {selectedCount > 0 && (
        <div className="selection-bar__row">
          <div className="selection-bar__actions">
            <button
              type="button"
              className="primary-button"
              onClick={() => setShowComposer(true)}
              disabled={!canBulk}
            >
              <Bell size={14} /> Notify {targetableCount} device{targetableCount === 1 ? '' : 's'}
            </button>
            {!singleSelected && (
              <button
                type="button"
                className="danger-button"
                onClick={() => setShowForceLogout(true)}
                disabled={!canBulk}
              >
                <LogOut size={14} /> Force logout {targetableCount}
              </button>
            )}
          </div>

          {singleSelected ? (
            // Single-device gating (Requirements 14.3, 14.6): ban / delete /
            // permanent-delete (and single force logout) are only offered for an
            // exactly-one selection, delegated to the shared per-device menu.
            <div className="selection-bar__single">
              <span className="muted small-text">Single-device actions:</span>
              <DeviceActionsMenu
                device={selectedDevices[0]}
                tenantId={tenantId}
                onActionComplete={onActionComplete}
              />
            </div>
          ) : (
            <span className="muted small-text">
              Ban, delete, and permanent delete require selecting exactly one device.
            </span>
          )}
        </div>
      )}

      {overCap && (
        <div className="tenant-error" role="alert">
          A bulk action can target at most {MAX_BULK_TARGETS} devices. {targetableCount} are selected —
          reduce the selection to notify or force logout.
        </div>
      )}

      {untargetable > 0 && (
        <p className="muted small-text" style={{ margin: 0 }}>
          {untargetable} selected device{untargetable === 1 ? '' : 's'} without an owner email can&rsquo;t be
          targeted by a bulk action.
        </p>
      )}

      {/* Bulk force-logout success/failure summary (Requirement 14.8). */}
      {bulkSummary && (
        <div className="notify-result" role="status">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
            <span style={{ fontWeight: 600 }}>
              Force logout complete: {bulkSummary.succeeded} succeeded, {bulkSummary.failed} failed.
            </span>
            <button
              type="button"
              className="text-button small-link"
              onClick={onDismissSummary}
              aria-label="Dismiss bulk action summary"
            >
              <X size={14} />
            </button>
          </div>
          {failedForceLogout.length > 0 && (
            <ul className="notify-recipient-list">
              {failedForceLogout.map((entry) => (
                <li key={`${entry.email}-${entry.deviceId}`} style={{ overflowWrap: 'anywhere' }}>
                  <span className="badge offline">Failed</span> {entry.deviceId}
                  {entry.email ? ` · ${entry.email}` : ''}
                  {entry.error ? ` — ${entry.error}` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {showComposer && (
        <NotificationComposer
          tenantId={tenantId}
          targets={targets}
          recipientLabels={labels}
          onClose={() => setShowComposer(false)}
          onSent={() => onActionComplete()}
        />
      )}

      {showForceLogout && (
        <BulkForceLogoutDialog
          tenantId={tenantId}
          targets={targets}
          onClose={() => setShowForceLogout(false)}
          onComplete={handleForceLogoutComplete}
        />
      )}
    </div>
  );
}
