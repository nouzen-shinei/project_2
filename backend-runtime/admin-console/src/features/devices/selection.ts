import type { DeviceAdminRecord } from '../../lib/apiClient';

/**
 * Pure selection-eligibility helpers for the Device Console.
 *
 * These live in a dependency-free module (only a type import, erased at build)
 * so both the React panel and the property tests can share the exact same
 * logic without dragging in the component/apiClient/store module graph.
 */

/** True when the device is in any logged-out state (manual, auto, or forced). */
export function isLoggedOut(device: DeviceAdminRecord): boolean {
  return (
    device.logoutType === 'manual' ||
    device.logoutType === 'forced' ||
    device.logoutType === 'auto' ||
    device.lastActivityType === 'logout' ||
    device.lastActivityType === 'forced_logout'
  );
}

/**
 * A Selectable_Device (Glossary) is eligible for notification/selection: it is
 * not deleted, not hard banned, and not logged out.
 */
export function isSelectableDevice(device: DeviceAdminRecord): boolean {
  return !device.isDeleted && !device.isHardBanned && !isLoggedOut(device);
}

/**
 * Prune a set of selected device ids against the latest device list so the
 * selection only ever contains currently-selectable devices (Requirement 14.5).
 *
 * A selected id is retained only when the list contains a device with that id
 * AND that device is a Selectable_Device; every id that is absent from the list
 * or refers to a now-ineligible device (deleted / hard banned / logged out) is
 * dropped, and nothing else is removed. Referential stability is preserved: when
 * no id needs pruning the original set is returned unchanged, which keeps the
 * panel from re-rendering on a no-op reload.
 */
export function pruneSelection(
  selected: Set<string>,
  devices: DeviceAdminRecord[],
): Set<string> {
  if (selected.size === 0) return selected;

  const eligibleIds = new Set(
    devices.filter(isSelectableDevice).map((device) => device.deviceId),
  );

  let changed = false;
  const next = new Set<string>();
  for (const id of selected) {
    if (eligibleIds.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : selected;
}
