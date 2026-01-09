import { describe, it, expect } from 'vitest';
import { __setProviders } from '../orchestrator.js';
import { enqueue, __queueLength } from '../retryQueue.js';
import { emailRetryGiveup, emailRetryAttempt } from '../metrics.js';

describe('retryQueue give-up', () => {
  it('gives up after max attempts and increments giveup counter', async () => {
    // Inject a provider that always transient-fails
    __setProviders({
      failer: {
        name: 'failer',
        async send() { return { success: false, transient: true, errorMessage: 'temp_down' }; }
      }
    } as any);

  const startGiveMetrics = await emailRetryGiveup.get();
  const startGive = (startGiveMetrics.values[0]?.value as number) || 0;
  const startAttemptMetrics = await emailRetryAttempt.get();
  const startAttempt = (startAttemptMetrics.values[0]?.value as number) || 0;

    // enqueue item with maxAttempts=2 so it will attempt twice then give up
    enqueue({ to:'giveup@example.com', kind:'custom', studentName:'G', messages:{ en:'Hi'}, order:'english-first', showLabels:true }, 0, 2);

    const deadline = Date.now() + 2000; // 2s timeout
  while((( (await emailRetryGiveup.get()).values[0]?.value as number)||0) === startGive && Date.now() < deadline){
      await new Promise(r=>setTimeout(r,40));
    }
  const endGiveMetrics = await emailRetryGiveup.get();
  const endGive = (endGiveMetrics.values[0]?.value as number) || 0;
    expect(endGive).toBe(startGive + 1);
    // Should have at least two retry attempts recorded (attempt 0 + attempt 1)
  const endAttemptMetrics = await emailRetryAttempt.get();
  const endAttempt = (endAttemptMetrics.values[0]?.value as number) || 0;
    expect(endAttempt - startAttempt).toBeGreaterThanOrEqual(2);
    expect(__queueLength()).toBe(0);
  });
});
