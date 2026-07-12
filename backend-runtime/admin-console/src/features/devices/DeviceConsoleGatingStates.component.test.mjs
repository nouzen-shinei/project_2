// Feature: device-console-migration, Task 13.8 — component tests for single-
// device gating and the history/timeline empty & error states.
//
// Renders the REAL components (SelectionBar, HistoryPanel, DeviceTimelinePanel)
// and drives them through the shared harness: prop-driven output via
// `renderToStaticMarkup`, and mount-effect-driven fetches via `createRoot` +
// `act` against a mocked global `fetch` (no network). See componentTestHarness.mjs.
//
// Coverage:
//   • Requirements 14.3, 14.6 — single-device gating: ban / delete /
//     permanent-delete are offered only when exactly one device is selected and
//     are withheld (with an explanatory message) when more than one is selected
//     (the UI portion of Property 19).
//   • Requirements 13.3, 17.6 — the history panel shows an empty-state when a
//     tenant has no records, and 13.4 — an error indication (no partial rows)
//     when the history fetch fails.
//   • Requirements 19.3, 19.5 — the device timeline shows an "unattributed"
//     indication for actions with no recorded actor, and an empty-state when a
//     device has no recorded actions.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, installFetch } from './componentTestHarness.mjs';

const ctx = await setup();
const { React, staticRender, mount } = ctx;

const { SelectionBar } = await import('./SelectionBar');
const { HistoryPanel } = await import('./HistoryPanel');
const { DeviceTimelinePanel } = await import('./DeviceTimelinePanel');
const { UNATTRIBUTED_LABEL } = await import('./deviceAudit');

const HISTORY_PATH = '/admin/tenants/devices/history';
const TIMELINE_PATH = '/admin/tenants/devices/timeline';

function selectableDevice(id) {
  return {
    deviceId: id,
    deviceType: 'web',
    deviceName: `Device ${id}`,
    ownerEmail: `owner-${id}@example.com`,
    isOnline: true,
    isDeleted: false,
    isHardBanned: false,
  };
}

const noop = () => {};

function renderSelectionBar(selectedDevices) {
  return staticRender(
    React.createElement(SelectionBar, {
      tenantId: 't-1',
      selectedDevices,
      selectableCount: selectedDevices.length,
      allSelectableSelected: true,
      bulkSummary: null,
      onSelectAllSelectable: noop,
      onClearSelection: noop,
      onBulkForceLogoutComplete: noop,
      onDismissSummary: noop,
      onActionComplete: noop,
    }),
  );
}

function buttonTexts(markup) {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return Array.from(host.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
}

// --- Single-device gating (Requirements 14.3, 14.6 — Property 19 UI portion) ---

test('Requirement 14.3/14.6: ban/delete/permanent-delete are offered when exactly one device is selected', () => {
  const markup = renderSelectionBar([selectableDevice('d1')]);
  const labels = buttonTexts(markup);

  assert.ok(labels.some((t) => /\bBan\b/.test(t)), 'Ban should be offered for a single selection');
  assert.ok(labels.some((t) => /\bDelete\b/.test(t)), 'Delete should be offered for a single selection');
  assert.ok(
    labels.some((t) => /Permanent delete/.test(t)),
    'Permanent delete should be offered for a single selection',
  );
  assert.doesNotMatch(
    markup,
    /require selecting exactly one device/,
    'no gating message should show for a single selection',
  );
});

test('Requirement 14.3/14.6: ban/delete/permanent-delete are gated off when more than one device is selected', () => {
  const markup = renderSelectionBar([selectableDevice('d1'), selectableDevice('d2')]);
  const labels = buttonTexts(markup);

  assert.match(
    markup,
    /Ban, delete, and permanent delete require selecting exactly one device/,
    'a gating message should explain the single-device requirement',
  );
  assert.ok(!labels.some((t) => /\bBan\b/.test(t)), 'Ban must not be offered for a multi-selection');
  assert.ok(
    !labels.some((t) => /Permanent delete/.test(t)),
    'Permanent delete must not be offered for a multi-selection',
  );
  // Bulk actions remain available for multiple devices.
  assert.ok(labels.some((t) => /Notify \d+ device/.test(t)), 'bulk notify should remain available');
  assert.ok(labels.some((t) => /Force logout \d+/.test(t)), 'bulk force-logout should remain available');
});

// --- History empty / error states (Requirements 13.3, 13.4, 17.6) ------------

test('Requirement 13.3/17.6: the history panel shows an empty state when there are no records', async () => {
  const fetchMock = installFetch((path) => {
    assert.equal(path, HISTORY_PATH);
    return { status: 200, data: { ok: true, entries: [], hasMore: false } };
  });
  try {
    const view = await mount(React.createElement(HistoryPanel, { tenantId: 't-1' }));
    assert.match(view.text(), /No history records exist for this tenant/, 'empty-state expected');
    view.unmount();
  } finally {
    fetchMock.restore();
  }
});

test('Requirement 13.4: the history panel shows an error indication (no partial rows) when the fetch fails', async () => {
  const fetchMock = installFetch(() => {
    throw new Error('history backend unavailable');
  });
  try {
    const view = await mount(React.createElement(HistoryPanel, { tenantId: 't-1' }));
    const text = view.text();
    assert.match(text, /History could not be loaded/, 'error indication expected');
    // No partial rows: there must be no rendered audit entries.
    const entries = view.container.querySelectorAll('.audit-entry');
    assert.equal(entries.length, 0, 'a failed history fetch must not render partial rows');
    view.unmount();
  } finally {
    fetchMock.restore();
  }
});

// --- Timeline empty / unattributed states (Requirements 19.3, 19.5) ----------

test('Requirement 19.5: the device timeline shows an empty state when there are no recorded actions', async () => {
  const fetchMock = installFetch((path) => {
    assert.equal(path, TIMELINE_PATH);
    return { status: 200, data: { ok: true, entries: [] } };
  });
  try {
    const view = await mount(
      React.createElement(DeviceTimelinePanel, {
        tenantId: 't-1',
        email: 'ada@example.com',
        deviceId: 'dev-9',
        onClose: noop,
      }),
    );
    assert.match(view.text(), /No actions have been recorded for this device/, 'timeline empty-state expected');
    view.unmount();
  } finally {
    fetchMock.restore();
  }
});

test('Requirement 19.3: the device timeline shows an "unattributed" indication for actions with no recorded actor', async () => {
  const fetchMock = installFetch(() => ({
    status: 200,
    data: {
      ok: true,
      entries: [
        {
          id: 'audit-1',
          tenantId: 't-1',
          action: 'force_logout',
          // no actorName / actorEmail / actorId -> unattributed
          targetDeviceId: 'dev-9',
          actionTimeMs: 1717236000000,
          createdAt: '2024-06-01T10:00:00.000Z',
        },
      ],
    },
  }));
  try {
    const view = await mount(
      React.createElement(DeviceTimelinePanel, {
        tenantId: 't-1',
        email: 'ada@example.com',
        deviceId: 'dev-9',
        onClose: noop,
      }),
    );
    assert.match(view.text(), new RegExp(UNATTRIBUTED_LABEL), 'unattributed indication expected');
    view.unmount();
  } finally {
    fetchMock.restore();
  }
});
