import assert from 'assert';
import { describe, it } from 'node:test';

const { shouldReopenUsageAlertAfterQuotaChange } = await import('../dist/jobs/tenantUsageRollup.js');

describe('usage alert acknowledgement reset', () => {
  it('keeps an acknowledged alert closed when the quota definition is unchanged', () => {
    const reopen = shouldReopenUsageAlertAfterQuotaChange({
      existingAlert: {
        acknowledgedAt: '2026-04-01T00:00:00.000Z',
        type: 'warning',
        limit: 100,
      },
      nextType: 'warning',
      nextLimit: 100,
    });

    assert.equal(reopen, false);
  });

  it('reopens an acknowledged alert when the limit changes', () => {
    const reopen = shouldReopenUsageAlertAfterQuotaChange({
      existingAlert: {
        acknowledgedAt: '2026-04-01T00:00:00.000Z',
        type: 'warning',
        limit: 100,
      },
      nextType: 'warning',
      nextLimit: 120,
    });

    assert.equal(reopen, true);
  });

  it('reopens an acknowledged alert when the severity changes', () => {
    const reopen = shouldReopenUsageAlertAfterQuotaChange({
      existingAlert: {
        acknowledgedAt: '2026-04-01T00:00:00.000Z',
        type: 'warning',
        limit: 100,
      },
      nextType: 'critical',
      nextLimit: 100,
    });

    assert.equal(reopen, true);
  });
});