// Feature: device-console-migration, Task 13.5 — component tests for the Device
// Console panel lifecycle.
//
// Exercises the REAL DeviceConsolePanel (and its DeviceStatsHeader / search /
// filter children) end to end: the panel calls the real `fetchTenantDevices`
// apiClient wrapper, which we drive through a mocked global `fetch` so no
// network is hit. Rendering + mount effects + async state settle inside React's
// `act` (see componentTestHarness.mjs), so these assert the panel's actual
// runtime behaviour rather than a re-implementation.
//
// Coverage:
//   • Requirement 1.1 — the panel is labelled "Device Console".
//   • Requirement 1.5 — the Refresh control re-fetches the device list.
//   • Requirement 1.7 — a list-load failure retains the previously displayed
//     devices and surfaces an error indication.
//   • Requirement 1.8 — an empty tenant shows an empty state with 0/0/0 counts.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, installFetch } from './componentTestHarness.mjs';

const ctx = await setup();
const { React, mount } = ctx;
const { DeviceConsolePanel } = await import('./DeviceConsolePanel');

const DEVICES_PATH = '/admin/tenants/devices';

/** A fully-populated, selectable device fixture. */
function sampleDevice(overrides = {}) {
  return {
    deviceId: 'dev-1',
    deviceType: 'web',
    deviceName: 'Ada’s Laptop',
    ownerEmail: 'ada@example.com',
    osName: 'macOS',
    osVersion: '14.5',
    browserName: 'Firefox',
    browserVersion: '128',
    ipAddress: '203.0.113.7',
    lastSeen: '2024-06-01T10:00:00.000Z',
    isOnline: true,
    ...overrides,
  };
}

function listResponse(devices, counts) {
  return {
    ok: true,
    tenantId: 't-1',
    counts: counts ?? { total: devices.length, online: devices.length, offline: 0 },
    devices,
  };
}

function render() {
  return mount(React.createElement(DeviceConsolePanel, { tenantId: 't-1' }));
}

test('Requirement 1.1: the panel is labelled "Device Console"', async () => {
  const fetchMock = installFetch(() => ({ status: 200, data: listResponse([], { total: 0, online: 0, offline: 0 }) }));
  try {
    const view = await render();
    assert.match(view.text(), /Device Console/);
    view.unmount();
  } finally {
    fetchMock.restore();
  }
});

test('Requirement 1.5: the Refresh control re-fetches the device list', async () => {
  const fetchMock = installFetch((path) => {
    assert.equal(path, DEVICES_PATH, 'panel should only call the device list endpoint');
    return { status: 200, data: listResponse([sampleDevice()]) };
  });
  try {
    const view = await render();
    // Mount triggered exactly one list fetch.
    assert.equal(fetchMock.calls.length, 1, 'expected one fetch on mount');

    const refresh = view.findButton(/Refresh/);
    assert.ok(refresh, 'Refresh control should be rendered');

    await view.click(refresh);
    assert.equal(fetchMock.calls.length, 2, 'Refresh should trigger a second fetch');

    view.unmount();
  } finally {
    fetchMock.restore();
  }
});

test('Requirement 1.7: a list-load failure retains prior data and shows an error', async () => {
  // First load succeeds (prior data), the refresh load rejects (transport
  // failure). apiRequest surfaces the rejection and the panel keeps the last
  // devices while showing the error banner.
  let call = 0;
  const fetchMock = installFetch(() => {
    call += 1;
    if (call === 1) return { status: 200, data: listResponse([sampleDevice()]) };
    throw new Error('network down');
  });
  try {
    const view = await render();
    assert.match(view.text(), /Ada’s Laptop/, 'prior device should be shown after the first load');

    const refresh = view.findButton(/Refresh/);
    await view.click(refresh);

    const text = view.text();
    assert.match(text, /Device list could not be loaded/, 'an error indication should be shown');
    assert.match(text, /Ada’s Laptop/, 'the previously loaded device should be retained on failure');

    view.unmount();
  } finally {
    fetchMock.restore();
  }
});

test('Requirement 1.8: an empty tenant shows an empty state with 0/0/0 counts', async () => {
  const fetchMock = installFetch(() => ({
    status: 200,
    data: listResponse([], { total: 0, online: 0, offline: 0 }),
  }));
  try {
    const view = await render();

    assert.match(view.text(), /No devices are associated with this tenant/, 'empty-state message expected');

    const statValues = Array.from(view.container.querySelectorAll('.stat-value')).map(
      (el) => el.textContent,
    );
    assert.equal(statValues.length, 3, 'total/online/offline stat cards expected');
    assert.deepEqual(statValues, ['0', '0', '0'], 'all counts should be zero for an empty tenant');

    view.unmount();
  } finally {
    fetchMock.restore();
  }
});
