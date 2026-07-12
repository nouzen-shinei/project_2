import { type ReactNode, useMemo, useState } from 'react';
import clsx from 'clsx';
import { Info, Monitor, Smartphone, Tablet, Users } from 'lucide-react';
import type { DeviceAdminRecord } from '../../lib/apiClient';
import { DeviceDetailModal } from './DeviceDetailModal';
import { DeviceActionsMenu } from './DeviceActionsMenu';

// The selectable-eligibility predicate + its `isLoggedOut` helper now live in a
// dependency-free `selection.ts` module (shared with the panel's pruning logic
// and the property tests). Re-exported here so existing importers are unchanged.
export { isLoggedOut, isSelectableDevice } from './selection';

/** Consistent placeholder rendered for missing / not-applicable attributes (Requirement 1.4). */
export const DEVICE_ATTR_PLACEHOLDER = '—';

/** Return the trimmed string value, or the shared placeholder when it is empty/absent. */
export function orPlaceholder(value: unknown): string {
  if (value === null || value === undefined) return DEVICE_ATTR_PLACEHOLDER;
  const str = typeof value === 'string' ? value.trim() : String(value);
  return str.length > 0 ? str : DEVICE_ATTR_PLACEHOLDER;
}

/** Format an ISO 8601 timestamp for display, falling back to the placeholder. */
export function formatDeviceTimestamp(iso?: string | null): string {
  if (!iso) return DEVICE_ATTR_PLACEHOLDER;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DEVICE_ATTR_PLACEHOLDER;
  return date.toLocaleString();
}

/** Combine the OS name/version (or platform) into a single display string. */
export function formatOs(device: DeviceAdminRecord): string {
  const combined = [device.osName, device.osVersion].filter(Boolean).join(' ').trim();
  if (combined) return combined;
  return orPlaceholder(device.platformOS);
}

/** Combine the browser name/version into a single display string (web devices). */
export function formatBrowser(device: DeviceAdminRecord): string {
  const combined = [device.browserName, device.browserVersion].filter(Boolean).join(' ').trim();
  return combined ? combined : DEVICE_ATTR_PLACEHOLDER;
}

/** True when the device's most recent activity was an administrator force-logout (Requirement 6.5). */
export function isForceLoggedOut(device: DeviceAdminRecord): boolean {
  return (
    device.logoutType === 'forced' ||
    device.lastActivityType === 'forced_logout' ||
    Boolean(device.forcedLogoutAt) ||
    Boolean(device.forcedLogoutBy)
  );
}

/** Primary status chip for a device row. Deleted / hard-banned take precedence over presence. */
export function deviceStatus(device: DeviceAdminRecord): { label: string; className: string } {
  if (device.isDeleted) return { label: 'Deleted', className: 'deleted' };
  if (device.isHardBanned) return { label: 'Hard banned', className: 'banned' };
  return device.isOnline ? { label: 'Online', className: 'online' } : { label: 'Offline', className: 'offline' };
}

export interface DeviceGroup {
  /** Stable key: lowercased owner email, or a sentinel for the no-owner group. */
  key: string;
  /** Original-cased owner email, or null for the no-owner group. */
  ownerEmail: string | null;
  /** Display label for the group header. */
  label: string;
  hasOwnerEmail: boolean;
  devices: DeviceAdminRecord[];
}

const NO_OWNER_KEY = '\uffff__no_owner__';
const NO_OWNER_LABEL = 'No owner email';

/**
 * Group flat devices by owner email (Requirement 5.6): groups are ordered by
 * owner email ascending (A→Z, case-insensitive), and any device with a
 * missing/blank owner email is collected into a single distinct group rendered
 * last (Requirement 5.7). Within a group the server order is preserved (the
 * backend already applied the requested in-group sort).
 */
export function groupDevicesByOwner(devices: DeviceAdminRecord[]): DeviceGroup[] {
  const owned = new Map<string, DeviceGroup>();
  const noOwner: DeviceGroup = {
    key: NO_OWNER_KEY,
    ownerEmail: null,
    label: NO_OWNER_LABEL,
    hasOwnerEmail: false,
    devices: [],
  };

  for (const device of devices) {
    const raw = typeof device.ownerEmail === 'string' ? device.ownerEmail.trim() : '';
    if (!raw) {
      noOwner.devices.push(device);
      continue;
    }
    const key = raw.toLowerCase();
    let group = owned.get(key);
    if (!group) {
      group = { key, ownerEmail: raw, label: raw, hasOwnerEmail: true, devices: [] };
      owned.set(key, group);
    }
    group.devices.push(device);
  }

  const sorted = Array.from(owned.values()).sort((a, b) => a.key.localeCompare(b.key));
  if (noOwner.devices.length > 0) sorted.push(noOwner);
  return sorted;
}

function DeviceTypeIcon({ type }: { type?: string }) {
  if (type === 'web') return <Monitor size={16} />;
  if (type === 'tablet') return <Tablet size={16} />;
  return <Smartphone size={16} />;
}

function Attr({ label, value }: { label: string; value: string }) {
  return (
    <div className="device-attr">
      <span className="device-attr__label">{label}</span>
      <span className="device-attr__value">{value}</span>
    </div>
  );
}

interface DeviceGroupListProps {
  devices: DeviceAdminRecord[];
  tenantId: string;
  /** Called after a per-device action resolves so the panel can reload counts + rows. */
  onActionComplete: () => void;
  /**
   * Optional per-row slot for a selection control (e.g. a checkbox). Left as a
   * render prop so the selection + bulk-action bar (task 13.4) can wire it in
   * later without reshaping this component.
   */
  renderSelectionControl?: (device: DeviceAdminRecord) => ReactNode;
}

/**
 * Renders the tenant's devices grouped by owner email (A→Z) with a distinct
 * final "No owner email" group (Requirements 5.6, 5.7). Each row surfaces the
 * device type, OS, browser (web), IP, last-seen time, and online/offline status,
 * displaying a placeholder for any attribute that is unavailable or not
 * applicable (Requirement 1.4). A "Details" control opens the full device detail
 * modal, and the per-device actions menu is rendered inline.
 */
export function DeviceGroupList({
  devices,
  tenantId,
  onActionComplete,
  renderSelectionControl,
}: DeviceGroupListProps) {
  const [detailDevice, setDetailDevice] = useState<DeviceAdminRecord | null>(null);
  const groups = useMemo(() => groupDevicesByOwner(devices), [devices]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
      {groups.map((group) => (
        <section className="device-group" key={group.key}>
          <header className={clsx('device-group__header', { 'no-owner': !group.hasOwnerEmail })}>
            {!group.hasOwnerEmail && <Users size={14} />}
            <span>{group.label}</span>
            <span className="device-group__count">
              {group.devices.length} device{group.devices.length === 1 ? '' : 's'}
            </span>
          </header>
          <ul className="device-list">
            {group.devices.map((device) => {
              const status = deviceStatus(device);
              const forced = isForceLoggedOut(device);
              return (
                <li className="device-row" key={device.deviceId}>
                  {renderSelectionControl && (
                    <div className="device-row__select">{renderSelectionControl(device)}</div>
                  )}
                  <div className="device-row__main">
                    <span className="device-row__icon">
                      <DeviceTypeIcon type={device.deviceType} />
                    </span>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
                        {orPlaceholder(device.deviceName)}
                      </div>
                      <div className="muted small-text" style={{ overflowWrap: 'anywhere' }}>
                        {device.deviceId}
                      </div>
                    </div>
                  </div>

                  <div className="device-row__attrs">
                    <Attr label="Type" value={orPlaceholder(device.deviceType)} />
                    <Attr label="OS" value={formatOs(device)} />
                    <Attr
                      label="Browser"
                      value={device.deviceType === 'web' ? formatBrowser(device) : DEVICE_ATTR_PLACEHOLDER}
                    />
                    <Attr label="IP" value={orPlaceholder(device.ipAddress)} />
                    <Attr label="Last seen" value={formatDeviceTimestamp(device.lastSeen)} />
                    <div className="device-attr">
                      <span className="device-attr__label">Status</span>
                      <span className="device-attr__value">
                        <span className={clsx('badge', status.className)}>{status.label}</span>
                        {forced && (
                          <span className="badge warning" style={{ marginLeft: '0.35rem' }}>
                            Force logged out
                          </span>
                        )}
                      </span>
                    </div>
                  </div>

                  <div className="device-row__actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setDetailDevice(device)}
                    >
                      <Info size={14} /> Details
                    </button>
                    <DeviceActionsMenu
                      device={device}
                      tenantId={tenantId}
                      onActionComplete={onActionComplete}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {detailDevice && (
        <DeviceDetailModal
          tenantId={tenantId}
          email={detailDevice.ownerEmail ?? ''}
          deviceId={detailDevice.deviceId}
          initialDevice={detailDevice}
          onClose={() => setDetailDevice(null)}
        />
      )}
    </div>
  );
}
