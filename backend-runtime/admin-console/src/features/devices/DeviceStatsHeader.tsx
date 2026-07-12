import { Smartphone, Wifi, WifiOff } from 'lucide-react';
import { StatCard } from '../../components/StatCard';
import { formatNumber } from '../../lib/metrics';
import type { DeviceCounts } from '../../lib/apiClient';

interface DeviceStatsHeaderProps {
  counts: DeviceCounts;
  loading?: boolean;
}

function safeCount(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Total / online / offline device counts for the Selected_Tenant.
 *
 * The counts are taken straight from the device list response (Requirement 1.3):
 * the backend computes online/offline using the 300-second window (Requirement
 * 1.6) and returns tenant-wide totals that are independent of the active
 * search/filter, so `online + offline === total` always holds and an empty
 * tenant renders `0 / 0 / 0` (Requirement 1.8).
 */
export function DeviceStatsHeader({ counts, loading }: DeviceStatsHeaderProps) {
  const total = safeCount(counts?.total);
  const online = safeCount(counts?.online);
  const offline = safeCount(counts?.offline);

  return (
    <div className="stat-grid">
      <StatCard
        icon={<Smartphone size={18} />}
        title="Total devices"
        value={<span className="stat-value">{formatNumber(total)}</span>}
        subtitle={loading ? 'Refreshing…' : 'Associated with the selected tenant'}
      />
      <StatCard
        icon={<Wifi size={18} />}
        title="Online"
        value={<span className="stat-value">{formatNumber(online)}</span>}
        badge={<span className="badge online">live</span>}
        subtitle="Seen within the last 5 minutes"
      />
      <StatCard
        icon={<WifiOff size={18} />}
        title="Offline"
        value={<span className="stat-value">{formatNumber(offline)}</span>}
        badge={<span className="badge offline">idle</span>}
        subtitle="No heartbeat within 5 minutes"
      />
    </div>
  );
}
