import clsx from 'clsx';
import type { DeviceFilter, DeviceSort } from '../../lib/apiClient';

/** The ten device filters surfaced by the Device Console (Requirement 5.1). */
export const DEVICE_FILTER_OPTIONS: Array<{ value: DeviceFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'web', label: 'Web' },
  { value: 'mobile', label: 'Mobile' },
  { value: 'tablet', label: 'Tablet' },
  { value: 'deleted', label: 'Deleted' },
  { value: 'logged_out', label: 'Logged out' },
  { value: 'force_logged_out', label: 'Force logged out' },
  { value: 'hard_banned', label: 'Hard banned' },
];

/** The four sort options offered by the Device Console (Requirement 5.3). */
export const DEVICE_SORT_OPTIONS: Array<{ value: DeviceSort; label: string }> = [
  { value: 'lastSeen', label: 'Last seen (newest first)' },
  { value: 'name', label: 'Device name (A–Z)' },
  { value: 'deviceType', label: 'Device type (A–Z)' },
  { value: 'status', label: 'Status (A–Z)' },
];

interface DeviceFilterBarProps {
  filter: DeviceFilter;
  sort: DeviceSort;
  hideInactive: boolean;
  onFilterChange: (filter: DeviceFilter) => void;
  onSortChange: (sort: DeviceSort) => void;
  onHideInactiveChange: (hideInactive: boolean) => void;
  disabled?: boolean;
}

/**
 * Filter chips (10 filters), sort selector (4 options), and the "Hide inactive
 * devices" toggle (Requirement 5). Selections are applied by the panel, which
 * forwards them to the list endpoint; the tenant-wide counts stay independent of
 * these controls.
 */
export function DeviceFilterBar({
  filter,
  sort,
  hideInactive,
  onFilterChange,
  onSortChange,
  onHideInactiveChange,
  disabled,
}: DeviceFilterBarProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
      <div
        role="group"
        aria-label="Filter devices"
        style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}
      >
        {DEVICE_FILTER_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={clsx('tab-chip', { active: option.value === filter })}
            onClick={() => onFilterChange(option.value)}
            disabled={disabled}
            aria-pressed={option.value === filter}
          >
            <span>{option.label}</span>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.25rem', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          <span>Sort by</span>
          <select
            value={sort}
            onChange={(event) => onSortChange(event.target.value as DeviceSort)}
            disabled={disabled}
            aria-label="Sort devices"
          >
            {DEVICE_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
          <input
            type="checkbox"
            checked={hideInactive}
            onChange={(event) => onHideInactiveChange(event.target.checked)}
            disabled={disabled}
            style={{ width: 'auto' }}
          />
          <span>Hide inactive devices</span>
        </label>
      </div>
    </div>
  );
}
