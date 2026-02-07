import { useSyncExternalStore } from 'react';
import { getDownloadState, subscribeDownloadState } from '@/lib/downloadStateStore';

type DownloadState = {
  isDownloading: boolean;
  progress: number;
};

const emptyState: DownloadState = { isDownloading: false, progress: 0 };

export const useDownloadState = (key?: string): DownloadState => {
  const safeKey = (key || '').trim();

  const subscribe = (listener: () => void) => {
    return subscribeDownloadState(safeKey, listener);
  };

  const getSnapshot = () => {
    if (!safeKey) return emptyState;
    return getDownloadState(safeKey) ?? emptyState;
  };

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};
