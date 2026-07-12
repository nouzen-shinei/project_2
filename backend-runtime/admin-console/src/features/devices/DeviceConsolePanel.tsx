import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { History, RefreshCcw, Smartphone, X } from 'lucide-react';
import { SectionCard } from '../../components/SectionCard';
import {
  ApiError,
  fetchTenantDevices,
  type BulkForceLogoutResponse,
  type DeviceAdminRecord,
  type DeviceCounts,
  type DeviceFilter,
  type DeviceSort,
} from '../../lib/apiClient';
import { DeviceStatsHeader } from './DeviceStatsHeader';
import { DeviceSearchBar } from './DeviceSearchBar';
import { DeviceFilterBar } from './DeviceFilterBar';
import { DeviceGroupList } from './DeviceGroupList';
import { isSelectableDevice, pruneSelection } from './selection';
import { HistoryPanel } from './HistoryPanel';
import { SelectionBar } from './SelectionBar';

/** The two views the Device Console surfaces: the device list and the tenant history. */
type ConsoleView = 'devices' | 'history';

const EMPTY_COUNTS: DeviceCounts = { total: 0, online: 0, offline: 0 };
const DEFAULT_FILTER: DeviceFilter = 'all';
const DEFAULT_SORT: DeviceSort = 'lastSeen';
const SEARCH_DEBOUNCE_MS = 300;

interface DeviceConsolePanelProps {
  /**
   * The Selected_Tenant. When omitted, the panel falls back to the
   * `?view=device-inspector&tenantId=…` deep link so the standalone inspector
   * view (task 14.1) and the sidebar tab both resolve a tenant the same way.
   */
  tenantId?: string;
}

function readTenantIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const params = new URLSearchParams(window.location.search);
  const view = (params.get('view') || '').trim().toLowerCase();
  if (view !== 'device-inspector') return null;
  return params.get('tenantId')?.trim() || null;
}

/**
 * Device Console shell (task 13.1). Owns the device fetch/refresh lifecycle for
 * the Selected_Tenant and renders the stats header, search bar, and filter/sort
 * controls. Search, filter, sort, and the hide-inactive toggle are forwarded to
 * the list endpoint (`fetchTenantDevices`) — server-side filtering — while the
 * total/online/offline counts always come from the response and reflect the full
 * tenant regardless of the active controls.
 *
 * Behavior:
 * - Requirement 1.7: a load failure retains any previously displayed devices and
 *   surfaces a dismissible error banner instead of blanking the view.
 * - Requirement 1.8: an empty tenant renders an empty state with `0 / 0 / 0`.
 * - Requirement 1.5: the refresh control re-fetches the current view.
 * - Requirement 3.5: with no Selected_Tenant scoped, no devices are shown.
 *
 * The grouped device rows, detail view, and per-device actions arrive with the
 * device list view (task 13.2); this shell renders a lightweight placeholder for
 * the loaded devices so those pieces slot in without reshaping the fetch state.
 */
export function DeviceConsolePanel({ tenantId }: DeviceConsolePanelProps) {
  const tenantIdFromUrl = useMemo(() => readTenantIdFromUrl(), []);
  const effectiveTenantId = (tenantId && tenantId.trim()) || tenantIdFromUrl || null;

  const [devices, setDevices] = useState<DeviceAdminRecord[]>([]);
  const [counts, setCounts] = useState<DeviceCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [hasLoaded, setHasLoaded] = useState(false);

  // Devices list vs. tenant action/notification history.
  const [view, setView] = useState<ConsoleView>('devices');

  // View controls forwarded to the list endpoint.
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<DeviceFilter>(DEFAULT_FILTER);
  const [sort, setSort] = useState<DeviceSort>(DEFAULT_SORT);
  const [hideInactive, setHideInactive] = useState(false);

  // Bulk selection lives here (task 13.4): a Set of selected deviceIds plus the
  // most recent bulk force-logout summary, which persists past the selection
  // being pruned so the outcome stays visible (Requirement 14.8).
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [bulkSummary, setBulkSummary] = useState<BulkForceLogoutResponse | null>(null);

  const requestIdRef = useRef(0);

  // Debounce the raw input into the committed search term that drives fetches.
  useEffect(() => {
    const handle = setTimeout(() => setSearch(searchInput.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  const loadDevices = useCallback(async () => {
    if (!effectiveTenantId) return;
    const requestId = (requestIdRef.current += 1);
    setLoading(true);
    setError(null);
    try {
      const trimmedSearch = search.trim();
      const response = await fetchTenantDevices({
        tenantId: effectiveTenantId,
        search: trimmedSearch ? trimmedSearch : undefined,
        filter,
        sort,
        hideInactive: hideInactive ? true : undefined,
      });
      if (requestIdRef.current !== requestId) return;
      const nextDevices = response.devices || [];
      setDevices(nextDevices);
      setCounts(response.counts || EMPTY_COUNTS);
      setLastUpdated(Date.now());
      setHasLoaded(true);

      // Requirement 14.5: on every successful reload, prune any selected id that
      // is no longer present or no longer eligible (a device that became
      // deleted / hard-banned / logged-out is no longer a Selectable_Device).
      // Functional update keeps `selectedIds` out of this callback's deps so a
      // selection change never re-triggers a fetch. `pruneSelection` returns the
      // same set instance when nothing changed, preserving referential stability.
      setSelectedIds((prev) => pruneSelection(prev, nextDevices));
    } catch (err) {
      if (requestIdRef.current !== requestId) return;
      console.warn('[DeviceConsolePanel] device list load failed', err);
      // Requirement 1.7: keep the previously displayed devices + counts intact
      // and only surface an error indication.
      if (err instanceof ApiError) {
        setError(`Device list could not be loaded (${err.status}).`);
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Device list could not be loaded for this tenant.');
      }
    } finally {
      if (requestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [effectiveTenantId, search, filter, sort, hideInactive]);

  // Fetch on scope change and whenever a control changes (loadDevices identity
  // captures the search/filter/sort/hideInactive dependencies).
  useEffect(() => {
    if (!effectiveTenantId) return;
    void loadDevices();
  }, [effectiveTenantId, loadDevices]);

  const handleRefresh = useCallback(() => {
    void loadDevices();
  }, [loadDevices]);

  const handleClearSearch = useCallback(() => {
    setSearchInput('');
    setSearch('');
  }, []);

  // Selection derivations. Only Selectable_Devices can be selected, and the
  // selected records are resolved in display order for stable bulk targets.
  const selectableDevices = useMemo(() => devices.filter(isSelectableDevice), [devices]);
  const selectableCount = selectableDevices.length;
  const selectedDevices = useMemo(
    () => devices.filter((device) => selectedIds.has(device.deviceId)),
    [devices, selectedIds],
  );
  const allSelectableSelected =
    selectableCount > 0 && selectableDevices.every((device) => selectedIds.has(device.deviceId));

  const toggleSelected = useCallback((deviceId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  }, []);

  const handleSelectAllSelectable = useCallback(() => {
    setSelectedIds(new Set(selectableDevices.map((device) => device.deviceId)));
  }, [selectableDevices]);

  const handleClearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const handleBulkForceLogoutComplete = useCallback(
    (result: BulkForceLogoutResponse) => {
      // Persist the summary (survives the imminent prune) and refresh the list,
      // which prunes the now-logged-out devices from the selection.
      setBulkSummary(result);
      void loadDevices();
    },
    [loadDevices],
  );

  // Per-row selection control (Requirement 14.1): a checkbox rendered only for
  // Selectable_Devices, wired into the `renderSelectionControl` slot exposed by
  // DeviceGroupList in task 13.2.
  const renderSelectionControl = useCallback(
    (device: DeviceAdminRecord): ReactNode => {
      if (!isSelectableDevice(device)) return null;
      const checked = selectedIds.has(device.deviceId);
      const label = device.deviceName?.trim() || device.deviceId;
      return (
        <label className="device-select-control">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => toggleSelected(device.deviceId)}
            aria-label={`Select ${label}`}
          />
        </label>
      );
    },
    [selectedIds, toggleSelected],
  );

  const trimmedSearch = search.trim();
  const searchActive = trimmedSearch.length > 0;
  const filterActive = filter !== DEFAULT_FILTER || hideInactive;
  const initialLoading = loading && !hasLoaded;
  const isEmptyTenant = hasLoaded && counts.total === 0;
  const hasNoResults = hasLoaded && counts.total > 0 && devices.length === 0;

  if (!effectiveTenantId) {
    return (
      <SectionCard
        title="Device Console"
        description="Inspect and manage the devices associated with a tenant."
      >
        <p className="muted">
          No tenant is selected. Open the Device Console from a tenant&rsquo;s &ldquo;Inspect devices&rdquo; control in
          the Tenant Directory to scope this view to a tenant.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Device Console"
      description="Inspect and manage the devices associated with the selected tenant."
      headerExtra={
        view === 'devices' ? (
          <button type="button" className="text-button" onClick={handleRefresh} disabled={loading}>
            <RefreshCcw size={14} /> {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        ) : undefined
      }
    >
      <div className="tenant-meta-row">
        <span className="muted small-text">Tenant: {effectiveTenantId}</span>
        {view === 'devices' && lastUpdated && (
          <span className="muted small-text">Updated {new Date(lastUpdated).toLocaleTimeString()}</span>
        )}
      </div>

      <div
        role="tablist"
        aria-label="Device Console views"
        style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === 'devices'}
          className={clsx('tab-chip', { active: view === 'devices' })}
          onClick={() => setView('devices')}
        >
          <Smartphone size={14} /> Devices
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'history'}
          className={clsx('tab-chip', { active: view === 'history' })}
          onClick={() => setView('history')}
        >
          <History size={14} /> History
        </button>
      </div>

      {view === 'history' ? (
        <HistoryPanel tenantId={effectiveTenantId} />
      ) : (
        <>
      <DeviceStatsHeader counts={counts} loading={loading} />

      <DeviceSearchBar
        value={searchInput}
        onChange={setSearchInput}
        onClear={handleClearSearch}
        disabled={initialLoading}
      />

      <DeviceFilterBar
        filter={filter}
        sort={sort}
        hideInactive={hideInactive}
        onFilterChange={setFilter}
        onSortChange={setSort}
        onHideInactiveChange={setHideInactive}
        disabled={initialLoading}
      />

      {error && (
        <div className="tenant-error" role="alert">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start' }}>
            <span>
              <strong>Device list could not be loaded.</strong> {error}
              {devices.length > 0 ? ' Showing the last loaded results.' : ''}
            </span>
            <button
              type="button"
              className="text-button small-link"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {initialLoading ? (
        <p className="muted">Loading devices…</p>
      ) : isEmptyTenant ? (
        <p className="muted">No devices are associated with this tenant.</p>
      ) : hasNoResults ? (
        searchActive ? (
          <p className="muted">No devices match &ldquo;{trimmedSearch}&rdquo;.</p>
        ) : filterActive ? (
          <p className="muted">No devices match the current filter.</p>
        ) : (
          <p className="muted">No devices to display.</p>
        )
      ) : devices.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {(selectedIds.size > 0 || bulkSummary) && (
            <SelectionBar
              tenantId={effectiveTenantId}
              selectedDevices={selectedDevices}
              selectableCount={selectableCount}
              allSelectableSelected={allSelectableSelected}
              bulkSummary={bulkSummary}
              onSelectAllSelectable={handleSelectAllSelectable}
              onClearSelection={handleClearSelection}
              onBulkForceLogoutComplete={handleBulkForceLogoutComplete}
              onDismissSummary={() => setBulkSummary(null)}
              onActionComplete={loadDevices}
            />
          )}
          <p className="muted small-text">
            Showing {devices.length} device{devices.length === 1 ? '' : 's'}.
          </p>
          <DeviceGroupList
            devices={devices}
            tenantId={effectiveTenantId}
            onActionComplete={loadDevices}
            renderSelectionControl={renderSelectionControl}
          />
        </div>
      ) : null}
        </>
      )}
    </SectionCard>
  );
}
