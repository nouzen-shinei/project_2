import assert from 'assert';
import { describe, it } from 'node:test';

process.env.TEST_MODE = '1';
// Default in code is 10s; setting explicitly keeps test resilient.
process.env.DAILY_QUOTES_WINDOW_EARLY_GRACE_SECONDS = '10';

const { __testEvaluateDeliveryWindow } = await import('../dist/dailyQuoteJob.js');

describe('daily quote delivery window grace', () => {
  it('treats 1s-before-08:00 local as within morning window', () => {
    const now = new Date('2026-01-08T02:29:59.985Z'); // 07:59:59 Asia/Kolkata
    const timezone = 'Asia/Kolkata';
    const deviceData = {
      lastDailyQuoteMorningDateKey: '2025-12-19',
      lastDailyQuoteEveningDateKey: '2026-01-07',
    };

    const due = __testEvaluateDeliveryWindow(now, timezone, deviceData, 'morning');
    assert.ok(due, 'expected device to be due');
    assert.strictEqual(due.timeOfDay, 'morning');
    assert.strictEqual(due.dateKey, '2026-01-08');
  });

  it('does not treat 20s-before-08:00 local as within morning window (grace=10s)', () => {
    const now = new Date('2026-01-08T02:29:40.000Z'); // 07:59:40 Asia/Kolkata
    const timezone = 'Asia/Kolkata';
    const deviceData = {
      lastDailyQuoteMorningDateKey: '2025-12-19',
      lastDailyQuoteEveningDateKey: '2026-01-07',
    };

    const due = __testEvaluateDeliveryWindow(now, timezone, deviceData, 'morning');
    assert.strictEqual(due, null);
  });

  it('does not send morning quote twice on same local date', () => {
    const now = new Date('2026-01-08T02:29:59.985Z'); // 07:59:59 Asia/Kolkata
    const timezone = 'Asia/Kolkata';
    const deviceData = {
      lastDailyQuoteMorningDateKey: '2026-01-08',
    };

    const due = __testEvaluateDeliveryWindow(now, timezone, deviceData, 'morning');
    assert.strictEqual(due, null);
  });
});
