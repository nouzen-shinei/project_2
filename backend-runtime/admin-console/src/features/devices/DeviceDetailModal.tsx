import { useEffect, useState } from 'react';
import { Ban, Bell, Clock, LogOut, Smartphone, Trash2, X } from 'lucide-react';
import { ApiError, fetchDeviceDetail, type DeviceAdminRecord } from '../../lib/apiClient';
import {
  DEVICE_ATTR_PLACEHOLDER,
  formatBrowser,
  formatDeviceTimestamp,
  formatOs,
  isForceLoggedOut,
  isSelectableDevice,
  orPlaceholder,
} from './DeviceGroupList';
import { DeviceTimelinePanel } from './DeviceTimelinePanel';
import { NotificationComposer } from './NotificationComposer';

interface DeviceDetailModalProps {
  tenantId: string;
  /** Owner email; empty when the device has no associated owner email. */
  email: string;
  deviceId: string;
  /** Row data shown immediately while the full detail is fetched. */
  initialDevice?: DeviceAdminRecord;
  onClose: () => void;
}

function DetailLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="device-attr">
      <span className="device-attr__label">{label}</span>
      <span className="device-attr__value">{value}</span>
    </div>
  );
}

function boolLabel(value: boolean | undefined): string {
  return value ? 'Yes' : 'No';
}

/**
 * Full device metadata + management status (Requirement 6.1) with deletion,
 * ban, and force-logout provenance blocks (Requirements 6.2–6.5). Opened from a
 * device row: it shows the row data immediately, then loads the authoritative
 * record via `fetchDeviceDetail`. If the record cannot be retrieved, an error
 * indication is surfaced (Requirement 6.6) while the last-known data stays
 * visible.
 */
export function DeviceDetailModal({
  tenantId,
  email,
  deviceId,
  initialDevice,
  onClose,
}: DeviceDetailModalProps) {
  const [device, setDevice] = useState<DeviceAdminRecord | null>(initialDevice ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);

  // Close on Escape.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Load the authoritative device record. The detail endpoint keys off the
  // owner email, so devices with no owner email fall back to the row data.
  useEffect(() => {
    const trimmedEmail = email.trim();
    if (!trimmedEmail) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDeviceDetail({ tenantId, email: trimmedEmail, deviceId })
      .then((response) => {
        if (!cancelled) setDevice(response.device);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setError(`Device details are unavailable (${err.status}).`);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Device details are unavailable.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, email, deviceId]);

  const deleted = Boolean(device?.isDeleted) || Boolean(device?.isRestored);
  const banned = Boolean(device?.isHardBanned);
  const forced = device ? isForceLoggedOut(device) : false;

  const trimmedEmail = email.trim();
  // The timeline endpoint keys off the owner email; notify additionally requires
  // the device to be a Selectable_Device (not deleted / banned / logged out).
  const canOpenTimeline = trimmedEmail.length > 0;
  const canNotify = canOpenTimeline && Boolean(device && isSelectableDevice(device));
  const notifyLabel = `${device?.deviceName?.trim() || deviceId}${trimmedEmail ? ` · ${trimmedEmail}` : ''}`;

  return (
    <>
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Device details"
      onClick={onClose}
    >
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <h2 className="modal-title">
            <Smartphone size={18} /> Device details
          </h2>
          <button type="button" className="text-button" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className="modal-body">
          {error && (
            <div className="tenant-error" role="alert">
              <strong>Device details are unavailable.</strong> {error}
              {device ? ' Showing the last loaded data.' : ''}
            </div>
          )}
          {loading && <p className="muted small-text">Loading full device detail…</p>}

          {!device ? (
            !error && <p className="muted">No device detail to display.</p>
          ) : (
            <>
              <section className="device-detail-section">
                <h3>Identity</h3>
                <div className="device-detail-grid">
                  <DetailLine label="Device ID" value={orPlaceholder(device.deviceId)} />
                  <DetailLine label="Device name" value={orPlaceholder(device.deviceName)} />
                  <DetailLine label="Type" value={orPlaceholder(device.deviceType)} />
                </div>
              </section>

              <section className="device-detail-section">
                <h3>Hardware &amp; platform</h3>
                <div className="device-detail-grid">
                  <DetailLine label="Model" value={orPlaceholder(device.modelName)} />
                  <DetailLine label="Manufacturer" value={orPlaceholder(device.manufacturer)} />
                  <DetailLine label="Brand" value={orPlaceholder(device.brand)} />
                  <DetailLine label="Operating system" value={formatOs(device)} />
                  <DetailLine label="Platform" value={orPlaceholder(device.platformOS)} />
                  <DetailLine
                    label="Browser"
                    value={device.deviceType === 'web' ? formatBrowser(device) : DEVICE_ATTR_PLACEHOLDER}
                  />
                  <DetailLine label="User agent" value={orPlaceholder(device.userAgent)} />
                </div>
              </section>

              <section className="device-detail-section">
                <h3>Network</h3>
                <div className="device-detail-grid">
                  <DetailLine label="IP address" value={orPlaceholder(device.ipAddress)} />
                  <DetailLine label="Network type" value={orPlaceholder(device.networkType)} />
                  <DetailLine label="Carrier" value={orPlaceholder(device.carrierName)} />
                  <DetailLine label="Country" value={orPlaceholder(device.countryCode)} />
                </div>
              </section>

              <section className="device-detail-section">
                <h3>Management status</h3>
                <div className="device-detail-grid">
                  <DetailLine label="Owner email" value={orPlaceholder(device.ownerEmail)} />
                  <DetailLine label="Owner name" value={orPlaceholder(device.ownerDisplayName)} />
                  <DetailLine label="Online" value={boolLabel(device.isOnline)} />
                  <DetailLine label="Last seen" value={formatDeviceTimestamp(device.lastSeen)} />
                  <DetailLine label="Session active" value={boolLabel(device.sessionActive)} />
                  <DetailLine label="Deleted" value={boolLabel(device.isDeleted)} />
                  <DetailLine label="Hard banned" value={boolLabel(device.isHardBanned)} />
                  <DetailLine label="Last activity" value={orPlaceholder(device.lastActivityType)} />
                </div>
              </section>

              {deleted && (
                <div className="provenance-block provenance-block--danger">
                  <span className="provenance-title">
                    <Trash2 size={15} /> Deletion
                  </span>
                  <DetailLine
                    label="Deleted by"
                    value={orPlaceholder(device.deletedByName || device.deletedBy)}
                  />
                  <DetailLine label="Deleted at" value={formatDeviceTimestamp(device.deletedAt)} />
                  <DetailLine label="Reason" value={orPlaceholder(device.deletionReason)} />
                  <DetailLine label="Restored" value={boolLabel(device.isRestored)} />
                  {device.isRestored && (
                    <DetailLine label="Restored at" value={formatDeviceTimestamp(device.restoredAt)} />
                  )}
                </div>
              )}

              {banned && (
                <div className="provenance-block provenance-block--danger">
                  <span className="provenance-title">
                    <Ban size={15} /> Hard ban
                  </span>
                  <DetailLine label="Hard banned" value="Yes" />
                  <p className="muted small-text" style={{ margin: 0 }}>
                    The banning administrator, reason, and expiration are recorded in the device
                    activity timeline.
                  </p>
                </div>
              )}

              {forced && (
                <div className="provenance-block provenance-block--warning">
                  <span className="provenance-title">
                    <LogOut size={15} /> Force logout
                  </span>
                  <DetailLine
                    label="Forced by"
                    value={orPlaceholder(device.forcedLogoutByName || device.forcedLogoutBy)}
                  />
                  <DetailLine label="Reason" value={orPlaceholder(device.forcedLogoutReason)} />
                  <DetailLine label="At" value={formatDeviceTimestamp(device.forcedLogoutAt)} />
                </div>
              )}
            </>
          )}
        </div>

        <footer className="modal-footer" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setTimelineOpen(true)}
              disabled={!canOpenTimeline}
              title={canOpenTimeline ? undefined : 'This device has no owner email'}
            >
              <Clock size={14} /> Activity timeline
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setComposerOpen(true)}
              disabled={!canNotify}
              title={canNotify ? undefined : 'Only active (selectable) devices can be notified'}
            >
              <Bell size={14} /> Notify device
            </button>
          </div>
          <button type="button" className="secondary-button" onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>

    {timelineOpen && (
      <DeviceTimelinePanel
        tenantId={tenantId}
        email={trimmedEmail}
        deviceId={deviceId}
        deviceLabel={device?.deviceName?.trim() || undefined}
        onClose={() => setTimelineOpen(false)}
      />
    )}

    {composerOpen && (
      <NotificationComposer
        tenantId={tenantId}
        targets={[{ email: trimmedEmail, deviceId }]}
        recipientLabels={[notifyLabel]}
        onClose={() => setComposerOpen(false)}
      />
    )}
    </>
  );
}
