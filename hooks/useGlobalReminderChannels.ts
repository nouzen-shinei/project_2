import { useCallback, useEffect, useState } from 'react';
import { reminderChannelPolicyService, type ReminderChannelPolicyDoc } from '../services/reminderChannelPolicyService';

export function useGlobalReminderChannels() {
  const [policy, setPolicy] = useState<ReminderChannelPolicyDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const doc = await reminderChannelPolicyService.load();
      setPolicy(doc);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reminder channel policy');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const unsub = reminderChannelPolicyService.subscribe((doc) => {
      setPolicy(doc);
    });
    return unsub;
  }, [load]);

  return { policy, loading, error, refresh: load };
}
