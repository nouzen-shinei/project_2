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

test('Recommendation #2: a hasMore response renders "Load more"; clicking it pages with the cursor and appends', async () => {
  // First page (no cursor) reports another page; the second page (sent with the
  // stored cursor) completes the list. The panel should APPEND the second page.
  const fetchMock = installFetch((path, init) => {
    assert.equal(path, DEVICES_PATH, 'panel should only call the device list endpoint');
    const body = JSON.parse(init?.body || '{}');
    if (!body.cursor) {
      return {
        status: 200,
        data: {
          ok: true,
          tenantId: 't-1',
          counts: { total: 2, online: 2, offline: 0 },
          devices: [sampleDevice({ deviceId: 'dev-1', deviceName: 'Ada Laptop' })],
          hasMore: true,
          nextCursor: 'cursor-1',
        },
      };
    }
    // Load-more must echo the stored cursor from the first response.
    assert.equal(body.cursor, 'cursor-1', 'load more should send the stored nextCursor');
    return {
      status: 200,
      data: {
        ok: true,
        tenantId: 't-1',
        counts: { total: 2, online: 2, offline: 0 },
        devices: [
          sampleDevice({
            deviceId: 'dev-2',
            deviceName: 'Grace Phone',
            deviceType: 'mobile',
            ownerEmail: 'grace@example.com',
          }),
        ],
        hasMore: false,
      },
    };
  });
  try {
    const view = await render();
    assert.equal(fetchMock.calls.length, 1, 'one list fetch on mount');
    assert.match(view.text(), /Ada Laptop/, 'first page device should be shown');

    const loadMore = view.findButton(/Load more/);
    assert.ok(loadMore, 'a "Load more" control should render when hasMore is true');

    await view.click(loadMore);

    assert.equal(fetchMock.calls.length, 2, 'clicking "Load more" should trigger a second fetch');
    const text = view.text();
    assert.match(text, /Ada Laptop/, 'the first-page device should be retained after appending');
    assert.match(text, /Grace Phone/, 'the second-page device should be appended');
    assert.match(text, /Showing 2 devices/, 'the count line should reflect the combined loaded list');

    // The last page reports hasMore=false, so the control disappears.
    assert.equal(view.findButton(/Load more/), null, '"Load more" should be gone once hasMore is false');

    view.unmount();
  } finally {
    fetchMock.restore();
  }
});

test('Recommendation #2: no "Load more" control when the first page reports hasMore false', async () => {
  const fetchMock = installFetch(() => ({
    status: 200,
    data: {
      ok: true,
      tenantId: 't-1',
      counts: { total: 1, online: 1, offline: 0 },
      devices: [sampleDevice()],
      hasMore: false,
    },
  }));
  try {
    const view = await render();
    assert.match(view.text(), /Ada’s Laptop/, 'the single device should be shown');
    assert.equal(view.findButton(/Load more/), null, '"Load more" should not render when hasMore is false');
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
