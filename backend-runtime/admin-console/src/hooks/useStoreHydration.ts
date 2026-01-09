import { useEffect, useState } from 'react';
import { useConfigStore } from '../store/configStore';

export function useConfigHydration() {
  const [hydrated, setHydrated] = useState(() => {
    const hasHydrated = (useConfigStore.persist?.hasHydrated?.() ?? false);
    return hasHydrated;
  });

  useEffect(() => {
    const unsub = useConfigStore.persist?.onFinishHydration(() => setHydrated(true));
    if (useConfigStore.persist?.hasHydrated?.()) {
      setHydrated(true);
    }
    return () => {
      unsub?.();
    };
  }, []);

  return hydrated;
}
