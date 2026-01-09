import { useMemo } from 'react';
import { useNetworkStatus } from './useNetworkStatus';

/**
 * Centralized offline-aware loading guard.
 * 
 * Contract:
 * - Pass the datasets that the screen relies on (arrays or null/undefined).
 * - Pass the loading flags for those datasets.
 * - If any loading flag is true, we show loading.
 * - If offline AND all datasets are empty/undefined/null (no live or cached data), we show loading.
 * - Otherwise, render the screen normally.
 */
export function useOfflineDataGate(
  datasets: Array<unknown[] | null | undefined>,
  loadingFlags: boolean[]
) {
  const { isOffline } = useNetworkStatus();

  const hasAnyLiveData = useMemo(() => {
    return datasets.some((d) => Array.isArray(d) ? d.length > 0 : !!d);
  }, [datasets]);

  const isStillLoading = useMemo(() => loadingFlags.some(Boolean), [loadingFlags]);

  const showLoading = isStillLoading || (isOffline && !hasAnyLiveData);
  const offlineHint = showLoading && isOffline && !hasAnyLiveData
    ? "You're offline. Waiting for connection…"
    : null;

  return {
    showLoading,
    isOffline,
    offlineHint,
  };
}
