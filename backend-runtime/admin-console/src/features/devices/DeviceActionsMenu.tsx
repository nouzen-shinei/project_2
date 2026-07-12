import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Ban, LogOut, RotateCcw, ShieldOff, Trash2, X } from 'lucide-react';
import {
  ApiError,
  banDevice,
  deleteDevice,
  forceLogoutDevice,
  permanentlyDeleteDevice,
  restoreDevice,
  unbanDevice,
  type DeviceAdminRecord,
} from '../../lib/apiClient';

/** Reason bounds shared by ban / delete / permanent-delete (Requirements 8.4, 9.2, 10.2). */
export const REASON_MIN_LENGTH = 1;
export const REASON_MAX_LENGTH = 500;

/** The single-device actions surfaced per row. */
export type DeviceActionKind =
  | 'force_logout'
  | 'ban'
  | 'unban'
  | 'delete'
  | 'restore'
  | 'permanent_delete';

/** Maps the backend error codes carried on `ApiError.data.error` to operator-facing copy. */
const ERROR_CODE_MESSAGES: Record<string, string> = {
  not_authorized: 'You are not authorized to perform this action.',
  unauthorized: 'Authentication is required to perform this action.',
  validation_failed: 'The request was rejected as invalid.',
  invalid_reason: `A reason of ${REASON_MIN_LENGTH}–${REASON_MAX_LENGTH} characters is required.`,
  invalid_expiration: 'The expiration time must be later than the ban creation time.',
  device_not_found: 'The device could not be found.',
  already_deleted: 'The device is already deleted.',
  not_deleted: 'The device is not deleted.',
  active_ban_exists: 'An active ban already exists for this device.',
  no_active_ban: 'There is no active ban to remove for this device.',
  tenant_scope_violation: 'The device is not associated with the selected tenant.',
  signal_write_failed: 'The force-logout request could not be registered.',
  delete_rolled_back: 'The permanent deletion did not complete and was rolled back.',
  audit_write_failed: 'The action was not recorded to the audit log.',
};

/**
 * Derive an operator-facing message from a failed device-action request,
 * preferring the stable backend error code carried on `ApiError.data` so the
 * operator sees why the action was rejected.
 */
export function describeDeviceApiError(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: unknown; message?: unknown } | null;
    const code = data && typeof data.error === 'string' ? data.error : undefined;
    if (code && ERROR_CODE_MESSAGES[code]) return ERROR_CODE_MESSAGES[code];
    if (data && typeof data.message === 'string' && data.message.trim()) return data.message.trim();
    if (code) return `Request failed (${code}).`;
    return `Request failed with status ${err.status}.`;
  }
  if (err instanceof Error) return err.message;
  return 'The action could not be completed.';
}

interface ActionConfig {
  title: string;
  description: string;
  confirmLabel: string;
  reasonMode: 'required' | 'optional' | 'none';
  requiresExplicitConfirm: boolean;
  supportsExpiration: boolean;
  destructive: boolean;
}

const ACTION_CONFIG: Record<DeviceActionKind, ActionConfig> = {
  force_logout: {
    title: 'Force logout device',
    description: 'Sign the user out of this device on its next check-in.',
    confirmLabel: 'Force logout',
    reasonMode: 'optional',
    requiresExplicitConfirm: false,
    supportsExpiration: false,
    destructive: false,
  },
  ban: {
    title: 'Ban device',
    description:
      'Create a hard ban for this device fingerprint, blocking its access. A reason is required.',
    confirmLabel: 'Ban device',
    reasonMode: 'required',
    requiresExplicitConfirm: false,
    supportsExpiration: true,
    destructive: true,
  },
  unban: {
    title: 'Remove device ban',
    description: 'Deactivate the active hard ban and restore this device’s access.',
    confirmLabel: 'Remove ban',
    reasonMode: 'optional',
    requiresExplicitConfirm: false,
    supportsExpiration: false,
    destructive: false,
  },
  delete: {
    title: 'Delete device',
    description:
      'Soft-delete this device and force it to sign out. It must re-register to regain access. A reason is required.',
    confirmLabel: 'Delete device',
    reasonMode: 'required',
    requiresExplicitConfirm: false,
    supportsExpiration: false,
    destructive: true,
  },
  restore: {
    title: 'Restore device',
    description: 'Restore this soft-deleted device to active status.',
    confirmLabel: 'Restore device',
    reasonMode: 'none',
    requiresExplicitConfirm: false,
    supportsExpiration: false,
    destructive: false,
  },
  permanent_delete: {
    title: 'Permanently delete device',
    description:
      'Permanently remove this device record and its related tracking data. This cannot be undone. A reason is required.',
    confirmLabel: 'Permanently delete',
    reasonMode: 'required',
    requiresExplicitConfirm: true,
    supportsExpiration: false,
    destructive: true,
  },
};

const ACTION_META: Record<DeviceActionKind, { label: string; icon: ReactNode; variant: 'secondary' | 'danger' }> = {
  force_logout: { label: 'Force logout', icon: <LogOut size={14} />, variant: 'secondary' },
  ban: { label: 'Ban', icon: <Ban size={14} />, variant: 'danger' },
  unban: { label: 'Unban', icon: <ShieldOff size={14} />, variant: 'secondary' },
  delete: { label: 'Delete', icon: <Trash2 size={14} />, variant: 'danger' },
  restore: { label: 'Restore', icon: <RotateCcw size={14} />, variant: 'secondary' },
  permanent_delete: { label: 'Permanent delete', icon: <Trash2 size={14} />, variant: 'danger' },
};

/**
 * Determine which single-device actions apply given the device's current state:
 * force logout (only while not deleted), ban ↔ unban gated on the hard-ban
 * state, delete ↔ restore gated on the deleted state, and permanent delete.
 */
function availableActions(device: DeviceAdminRecord): DeviceActionKind[] {
  const actions: DeviceActionKind[] = [];
  if (!device.isDeleted) actions.push('force_logout');
  actions.push(device.isHardBanned ? 'unban' : 'ban');
  actions.push(device.isDeleted ? 'restore' : 'delete');
  actions.push('permanent_delete');
  return actions;
}

interface ActionConfirmDialogProps {
  action: DeviceActionKind;
  device: DeviceAdminRecord;
  tenantId: string;
  email: string;
  onClose: () => void;
  onSuccess: () => void;
}

/**
 * Confirmation dialog for a single device action. Ban / delete / permanent-delete
 * require a non-empty reason (validated client-side before the confirm button
 * enables); permanent delete additionally requires an explicit confirmation
 * checkbox. Backend error codes are surfaced to the operator on failure.
 */
function ActionConfirmDialog({
  action,
  device,
  tenantId,
  email,
  onClose,
  onSuccess,
}: ActionConfirmDialogProps) {
  const config = ACTION_CONFIG[action];
  const [reason, setReason] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const trimmedReason = reason.trim();
  const reasonTooLong = trimmedReason.length > REASON_MAX_LENGTH;
  const reasonValid =
    config.reasonMode === 'required'
      ? trimmedReason.length >= REASON_MIN_LENGTH && trimmedReason.length <= REASON_MAX_LENGTH
      : !reasonTooLong;
  const confirmValid = !config.requiresExplicitConfirm || confirmChecked;
  const canSubmit = reasonValid && confirmValid && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    const base = { tenantId, email, deviceId: device.deviceId };
    try {
      switch (action) {
        case 'force_logout':
          await forceLogoutDevice({ ...base, reason: trimmedReason || undefined });
          break;
        case 'ban':
          await banDevice({
            ...base,
            reason: trimmedReason,
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : undefined,
          });
          break;
        case 'unban':
          await unbanDevice({ ...base, reason: trimmedReason || undefined });
          break;
        case 'delete':
          await deleteDevice({ ...base, reason: trimmedReason });
          break;
        case 'restore':
          await restoreDevice({ ...base });
          break;
        case 'permanent_delete':
          await permanentlyDeleteDevice({ ...base, reason: trimmedReason });
          break;
      }
      onSuccess();
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
      aria-label={config.title}
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div className="modal-card modal-card--sm" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2 className="modal-title">
            {config.destructive && <AlertTriangle size={18} color="#f87171" />}
            {config.title}
          </h2>
          <button
            type="button"
            className="text-button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <div className="modal-body">
          <p className="muted" style={{ margin: 0 }}>
            {config.description}
          </p>
          <div style={{ fontSize: '0.82rem' }}>
            <span className="device-attr__label">Device</span>
            <div style={{ overflowWrap: 'anywhere' }}>
              {device.deviceName?.trim() || device.deviceId}
              <span className="muted small-text"> · {email}</span>
            </div>
          </div>

          {config.reasonMode !== 'none' && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <span>
                Reason
                {config.reasonMode === 'required' ? <span style={{ color: '#f87171' }}> *</span> : ' (optional)'}
              </span>
              <textarea
                className="textarea"
                value={reason}
                maxLength={REASON_MAX_LENGTH}
                onChange={(event) => setReason(event.target.value)}
                placeholder={
                  config.reasonMode === 'required'
                    ? 'Provide a reason for this action…'
                    : 'Optional reason…'
                }
                disabled={submitting}
              />
              <span className="char-count">
                {trimmedReason.length}/{REASON_MAX_LENGTH}
              </span>
            </label>
          )}

          {config.supportsExpiration && (
            <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
              <span>Ban expiration (optional)</span>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(event) => setExpiresAt(event.target.value)}
                disabled={submitting}
              />
            </label>
          )}

          {config.requiresExplicitConfirm && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={confirmChecked}
                onChange={(event) => setConfirmChecked(event.target.checked)}
                disabled={submitting}
              />
              <span>
                I understand this permanently deletes the device record and its related tracking
                data and cannot be undone.
              </span>
            </label>
          )}

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
          <button
            type="button"
            className={config.destructive ? 'danger-button' : 'primary-button'}
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? 'Working…' : config.confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

interface DeviceActionsMenuProps {
  device: DeviceAdminRecord;
  tenantId: string;
  /** Called after an action resolves successfully so the panel reloads state. */
  onActionComplete: () => void;
}

/**
 * Per-device action controls: force logout, ban ↔ unban, delete ↔ restore, and
 * permanent delete. Each action opens a confirmation dialog (the confirm step);
 * ban / delete / permanent-delete require a reason and permanent delete requires
 * an explicit confirmation. Actions are wired to the `apiClient` device
 * functions and, on success, trigger the panel reload so counts and rows reflect
 * the new state.
 */
export function DeviceActionsMenu({ device, tenantId, onActionComplete }: DeviceActionsMenuProps) {
  const [activeAction, setActiveAction] = useState<DeviceActionKind | null>(null);

  const email = (device.ownerEmail ?? '').trim();
  const canAct = email.length > 0;
  const actions = useMemo(() => availableActions(device), [device]);

  if (!canAct) {
    return <span className="muted small-text">Actions require an owner email</span>;
  }

  const handleSuccess = () => {
    setActiveAction(null);
    onActionComplete();
  };

  return (
    <>
      {actions.map((action) => {
        const meta = ACTION_META[action];
        return (
          <button
            key={action}
            type="button"
            className={meta.variant === 'danger' ? 'danger-button' : 'secondary-button'}
            onClick={() => setActiveAction(action)}
          >
            {meta.icon} {meta.label}
          </button>
        );
      })}

      {activeAction && (
        <ActionConfirmDialog
          action={activeAction}
          device={device}
          tenantId={tenantId}
          email={email}
          onClose={() => setActiveAction(null)}
          onSuccess={handleSuccess}
        />
      )}
    </>
  );
}
