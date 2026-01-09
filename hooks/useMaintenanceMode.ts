import { useEffect, useMemo, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { firestore } from '../config/firebase';

export type MaintenanceModeDoc = {
  enabled?: boolean;
  message?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type MaintenanceModeState = {
  loading: boolean;
  enabled: boolean;
  message: string;
  lastUpdatedAt?: string;
  error?: string;
};

const DEFAULT_MESSAGE = 'We are currently performing maintenance. Please try again shortly.';

export function useMaintenanceMode(): MaintenanceModeState {
  const ref = useMemo(() => doc(firestore, 'appConfig', 'maintenance'), []);
  const [state, setState] = useState<MaintenanceModeState>({
    loading: true,
    enabled: false,
    message: DEFAULT_MESSAGE,
  });

  useEffect(() => {
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (!snap.exists()) {
          setState({ loading: false, enabled: false, message: DEFAULT_MESSAGE });
          return;
        }

        const raw = snap.data() as MaintenanceModeDoc;
        const enabled = Boolean(raw?.enabled);
        const message = (raw?.message || '').toString().trim() || DEFAULT_MESSAGE;
        const lastUpdatedAt = raw?.updatedAt;

        setState({ loading: false, enabled, message, lastUpdatedAt });
      },
      (error) => {
        setState({ loading: false, enabled: false, message: DEFAULT_MESSAGE, error: error?.message || 'Failed to load maintenance status' });
      }
    );

    return unsubscribe;
  }, [ref]);

  return state;
}
