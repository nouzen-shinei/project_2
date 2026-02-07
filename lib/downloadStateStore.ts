type DownloadState = {
  isDownloading: boolean;
  progress: number;
};

type DownloadListener = () => void;

const downloadStateMap = new Map<string, DownloadState>();
const downloadListeners = new Map<string, Set<DownloadListener>>();

const notifyListeners = (key: string) => {
  const listeners = downloadListeners.get(key);
  if (!listeners || listeners.size === 0) {
    return;
  }
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // Ignore listener errors.
    }
  });
};

export const setDownloadState = (key: string, state: DownloadState) => {
  if (!key) return;
  downloadStateMap.set(key, state);
  notifyListeners(key);
};

export const clearDownloadState = (key: string) => {
  if (!key) return;
  if (!downloadStateMap.has(key)) return;
  downloadStateMap.delete(key);
  notifyListeners(key);
};

export const getDownloadState = (key: string): DownloadState | undefined => {
  if (!key) return undefined;
  return downloadStateMap.get(key);
};

export const subscribeDownloadState = (key: string, listener: DownloadListener): (() => void) => {
  if (!key) {
    return () => {};
  }

  const existing = downloadListeners.get(key);
  if (existing) {
    existing.add(listener);
  } else {
    downloadListeners.set(key, new Set([listener]));
  }

  return () => {
    const listeners = downloadListeners.get(key);
    if (!listeners) return;
    listeners.delete(listener);
    if (listeners.size === 0) {
      downloadListeners.delete(key);
    }
  };
};
