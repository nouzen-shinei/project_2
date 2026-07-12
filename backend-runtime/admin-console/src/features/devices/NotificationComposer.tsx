import { useEffect, useMemo, useState } from 'react';
import { Bell, Send, X } from 'lucide-react';
import {
  notifyDevices,
  type DeviceNotifyPriority,
  type DeviceTarget,
  type NotifyDevicesResponse,
} from '../../lib/apiClient';
import { describeDeviceApiError } from './DeviceActionsMenu';

/** Title bounds enforced client-side before Send enables (Requirement 12.1, 12.4). */
export const TITLE_MIN_LENGTH = 1;
export const TITLE_MAX_LENGTH = 100;

/** Message bounds enforced client-side before Send enables (Requirement 12.1, 12.4). */
export const MESSAGE_MIN_LENGTH = 1;
export const MESSAGE_MAX_LENGTH = 500;

/** The notify endpoint caps the recipient list at 500 targets (Requirement 12.6 support). */
export const MAX_NOTIFY_TARGETS = 500;

/** How many recipient labels to list before collapsing into a "+N more" summary. */
const RECIPIENT_PREVIEW_LIMIT = 8;

const PRIORITY_OPTIONS: Array<{ value: DeviceNotifyPriority; label: string }> = [
  { value: 'high', label: 'High' },
  { value: 'normal', label: 'Normal' },
  { value: 'low', label: 'Low' },
];

interface NotificationComposerProps {
  tenantId: string;
  /**
   * The devices the notification targets. A single-element array when opened for
   * one device (from a device's detail); the multi-select bulk bar (task 13.4)
   * reuses this same component by passing the full selection — no rework needed.
   */
  targets: DeviceTarget[];
  /**
   * Optional readable labels for the targeted devices (e.g. device name + owner
   * email), aligned by index with `targets`. When omitted, a label is derived
   * from each target's device id and email.
   */
  recipientLabels?: string[];
  onClose: () => void;
  /** Called after a send resolves so the opener can refresh history, etc. */
  onSent?: (result: NotifyDevicesResponse) => void;
}

/**
 * Notification composer (Requirement 12). Enforces the title (1–100) and message
 * (1–500) bounds client-side — Send only enables once both are non-empty after
 * trimming and within range — shows a recipient summary (how many / which devices
 * are targeted) and surfaces the 500-recipient cap when exceeded. On send it
 * wires to `notifyDevices` and renders the per-target success/failure summary
 * returned by the endpoint (Requirement 12.5).
 *
 * Rendered as a modal so it can be opened for a single targeted device today and
 * reused unchanged by the bulk selection bar (task 13.4).
 */
export function NotificationComposer({
  tenantId,
  targets,
  recipientLabels,
  onClose,
  onSent,
}: NotificationComposerProps) {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [priority, setPriority] = useState<DeviceNotifyPriority>('normal');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NotifyDevicesResponse | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const recipientCount = targets.length;
  const hasRecipients = recipientCount > 0;
  const tooManyRecipients = recipientCount > MAX_NOTIFY_TARGETS;

  // Readable labels for the recipient summary: use the supplied labels where
  // present, otherwise fall back to "deviceId · email".
  const labels = useMemo(
    () =>
      targets.map((target, index) => {
        const supplied = recipientLabels?.[index]?.trim();
        if (supplied) return supplied;
        const email = target.email?.trim();
        return email ? `${target.deviceId} · ${email}` : target.deviceId;
      }),
    [targets, recipientLabels],
  );

  const previewLabels = labels.slice(0, RECIPIENT_PREVIEW_LIMIT);
  const remaining = labels.length - previewLabels.length;

  const trimmedTitle = title.trim();
  const trimmedMessage = message.trim();
  const titleValid = trimmedTitle.length >= TITLE_MIN_LENGTH && trimmedTitle.length <= TITLE_MAX_LENGTH;
  const messageValid =
    trimmedMessage.length >= MESSAGE_MIN_LENGTH && trimmedMessage.length <= MESSAGE_MAX_LENGTH;

  // Requirement 12.4: identify the invalid field; Requirement 12.6: require ≥1 recipient.
  const titleError = title.length > 0 && !titleValid ? `Title must be ${TITLE_MIN_LENGTH}–${TITLE_MAX_LENGTH} characters.` : null;
  const messageError =
    message.length > 0 && !messageValid ? `Message must be ${MESSAGE_MIN_LENGTH}–${MESSAGE_MAX_LENGTH} characters.` : null;

  const canSend = titleValid && messageValid && hasRecipients && !tooManyRecipients && !submitting;

  const handleSend = async () => {
    if (!canSend) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const response = await notifyDevices({
        tenantId,
        title: trimmedTitle,
        body: trimmedMessage,
        targets,
        priority,
      });
      setResult(response);
      onSent?.(response);
    } catch (err) {
      setError(describeDeviceApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const failedResults = result?.results?.filter((entry) => !entry.ok) ?? [];

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Compose notification"
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div className="modal-card modal-card--sm" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2 className="modal-title">
            <Bell size={18} /> Compose notification
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
          {/* Recipient summary (Requirement 12.6 support): how many / which devices. */}
          <div className="notify-recipients">
            <span className="device-attr__label">Recipients</span>
            {hasRecipients ? (
              <>
                <div style={{ fontWeight: 600 }}>
                  {recipientCount} device{recipientCount === 1 ? '' : 's'} targeted
                </div>
                <ul className="notify-recipient-list">
                  {previewLabels.map((label, index) => (
                    <li key={`${label}-${index}`} style={{ overflowWrap: 'anywhere' }}>
                      {label}
                    </li>
                  ))}
                </ul>
                {remaining > 0 && (
                  <span className="muted small-text">and {remaining} more…</span>
                )}
              </>
            ) : (
              // Requirement 12.6: at least one recipient must be selected.
              <div className="tenant-error" role="alert">
                Select at least one recipient before composing a notification.
              </div>
            )}
            {tooManyRecipients && (
              <div className="tenant-error" role="alert">
                A notification can target at most {MAX_NOTIFY_TARGETS} devices. {recipientCount} are
                selected — reduce the selection to send.
              </div>
            )}
          </div>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <span>
              Title<span style={{ color: '#f87171' }}> *</span>
            </span>
            <input
              type="text"
              value={title}
              maxLength={TITLE_MAX_LENGTH}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Notification title"
              disabled={submitting}
              aria-label="Notification title"
            />
            <span className="char-count">
              {trimmedTitle.length}/{TITLE_MAX_LENGTH}
            </span>
            {titleError && (
              <span className="small-text" style={{ color: '#f87171' }}>
                {titleError}
              </span>
            )}
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <span>
              Message<span style={{ color: '#f87171' }}> *</span>
            </span>
            <textarea
              className="textarea"
              value={message}
              maxLength={MESSAGE_MAX_LENGTH}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Notification message"
              disabled={submitting}
              aria-label="Notification message"
            />
            <span className="char-count">
              {trimmedMessage.length}/{MESSAGE_MAX_LENGTH}
            </span>
            {messageError && (
              <span className="small-text" style={{ color: '#f87171' }}>
                {messageError}
              </span>
            )}
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <span>Priority</span>
            <select
              value={priority}
              onChange={(event) => setPriority(event.target.value as DeviceNotifyPriority)}
              disabled={submitting}
              aria-label="Notification priority"
            >
              {PRIORITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {error && (
            <div className="tenant-error" role="alert">
              {error}
            </div>
          )}

          {/* Per-target success/failure summary from the notify response (Requirement 12.5). */}
          {result && (
            <div className="notify-result" role="status">
              <div style={{ fontWeight: 600 }}>
                Delivery complete: {result.successful} succeeded, {result.failed} failed.
              </div>
              {failedResults.length > 0 && (
                <ul className="notify-recipient-list">
                  {failedResults.map((entry) => (
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
        </div>

        <footer className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={submitting}>
            {result ? 'Close' : 'Cancel'}
          </button>
          {!result && (
            <button type="button" className="primary-button" onClick={handleSend} disabled={!canSend}>
              <Send size={14} /> {submitting ? 'Sending…' : 'Send notification'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
