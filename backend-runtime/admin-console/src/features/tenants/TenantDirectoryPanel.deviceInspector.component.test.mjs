// Feature: device-console-migration, Task 15.2 — component tests for the
// "Inspect devices" entry point that task 15.1 added to TenantDirectoryPanel.
//
// Exercises the REAL TenantDirectoryPanel end to end: on mount the panel calls
// the real `searchTenants` apiClient wrapper, which we drive through a mocked
// global `fetch` (see ../devices/componentTestHarness.mjs) so no network is
// hit. Rendering + mount effects + async state settle inside React's `act`, so
// these assert the panel's actual runtime behaviour rather than a
// re-implementation. The shared harness is reused as-is (tasks 13.5/13.6/13.8).
//
// Coverage:
//   • Requirement 2.1 — an "Inspect devices" control renders for each tenant.
//   • Requirement 2.2 — it sits within the same tenant entry (the shared
//     `tenant-row-actions` container) as "Inspect members".
//   • Requirement 2.3 — activating it opens the Device Console scoped to that
//     tenant via a `?tab=devices&view=device-inspector&tenantId=<id>` deep link.
//   • Requirement 2.4 — if opening fails, the Tenant Directory view is retained
//     and an inline error (role="alert") is shown for that tenant.

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, installFetch } from '../devices/componentTestHarness.mjs';

const ctx = await setup();
const { React, mount } = ctx;
const { TenantDirectoryPanel } = await import('./TenantDirectoryPanel');

const SEARCH_PATH = '/admin/tenants/search';

// Two deterministic tenants so per-tenant rendering and per-tenant errors can
// be told apart. Shapes match the `TenantAdminSummary` fields the row renders.
const TENANTS = [
  {
    id: 'tenant-alpha',
    name: 'Alpha Academy',
    slug: 'alpha',
    status: 'active',
    billingTier: 'pro',
    ownerEmail: 'owner@alpha.test',
  },
  {
    id: 'tenant-bravo',
    name: 'Bravo Institute',
    slug: 'bravo',
    status: 'active',
    billingTier: 'free',
    ownerEmail: 'owner@bravo.test',
  },
];

/** A well-formed `TenantSearchResponse` for the mocked `/admin/tenants/search`. */
function searchResponse(tenants = TENANTS) {
  return {
    results: tenants,
    total: tenants.length,
    diagnostics: { query: '', matchedBy: [], fallbackApplied: false },
  };
}

/**
 * Resolve the tenant-list load; return a benign `{ ok: true }` for any other
 * path so the panel mounts cleanly even if a secondary fetch fires.
 */
function tenantListHandler(path) {
  if (path === SEARCH_PATH) {
    return { status: 200, data: searchResponse() };
  }
  return { status: 200, data: { ok: true } };
}

function render() {
  return mount(React.createElement(TenantDirectoryPanel));
}

/** Buttons in `root` whose visible text matches `re`. */
function buttonsMatching(root, re) {
  return Array.from(root.querySelectorAll('button')).filter((b) => re.test(b.textContent || ''));
}

/**
 * Replace `window.open` with `impl`, returning a restore function. The panel's
 * handler calls the global `window.open`, which the harness exposes as
 * `globalThis.window.open`.
 */
function stubWindowOpen(impl) {
  const original = globalThis.window.open;
  globalThis.window.open = impl;
  return () => {
    globalThis.window.open = original;
  };
}

test('Requirement 2.1/2.2: an "Inspect devices" control renders per tenant beside "Inspect members"', async () => {
  const fetchMock = installFetch(tenantListHandler);
  try {
    const view = await render();

    // The mocked list load resolved with both tenants.
    assert.match(view.text(), /Alpha Academy/, 'first tenant should be rendered');
    assert.match(view.text(), /Bravo Institute/, 'second tenant should be rendered');

    // One "Inspect devices" control per tenant.
    const inspectDevices = buttonsMatching(view.container, /Inspect devices/);
    assert.equal(
      inspectDevices.length,
      TENANTS.length,
      'expected one "Inspect devices" control for each tenant row',
    );

    // Each tenant row has an actions container holding BOTH controls together.
    const actionContainers = Array.from(view.container.querySelectorAll('.tenant-row-actions'));
    assert.equal(actionContainers.length, TENANTS.length, 'one actions container per tenant');
    for (const actions of actionContainers) {
      const labels = Array.from(actions.querySelectorAll('button')).map((b) => (b.textContent || '').trim());
      assert.ok(
        labels.some((l) => /Inspect devices/.test(l)),
        'each tenant entry should contain an "Inspect devices" control',
      );
      assert.ok(
        labels.some((l) => /Inspect members/.test(l)),
        '"Inspect devices" should sit in the same entry as "Inspect members"',
      );
    }

    view.unmount();
  } finally {
    fetchMock.restore();
  }
});

test('Requirement 2.3: activating the control opens the tenant-scoped Device Console deep link', async () => {
  const fetchMock = installFetch(tenantListHandler);
  let capturedUrl = null;
  let capturedTarget = null;
  // Return a truthy stand-in window so the handler treats the open as success.
  const restoreOpen = stubWindowOpen((url, target) => {
    capturedUrl = String(url);
    capturedTarget = target;
    return {};
  });
  try {
    const view = await render();

    // Click the second tenant's control so the tenantId in the URL is unambiguous.
    const rows = Array.from(view.container.querySelectorAll('tbody tr'));
    assert.equal(rows.length, TENANTS.length, 'both tenant rows should be present');
    const target = TENANTS[1];
    const [button] = buttonsMatching(rows[1], /Inspect devices/);
    assert.ok(button, '"Inspect devices" control should exist on the tenant row');

    await view.click(button);

    assert.ok(capturedUrl, 'window.open should have been invoked with a URL');
    assert.match(capturedUrl, /view=device-inspector/, 'deep link should target the device inspector view');
    assert.match(capturedUrl, /tab=devices/, 'deep link should select the devices tab');
    assert.match(
      capturedUrl,
      new RegExp(`tenantId=${target.id}`),
      'deep link should scope to the activated tenant',
    );
    assert.equal(capturedTarget, '_blank', 'Device Console should open in a new tab');

    // No inline error surfaced on a successful open.
    assert.equal(
      view.container.querySelectorAll('.tenant-error[role="alert"]').length,
      0,
      'no device-inspector error should be shown when the open succeeds',
    );

    view.unmount();
  } finally {
    restoreOpen();
    fetchMock.restore();
  }
});

test('Requirement 2.4: an open failure retains the directory and shows an inline error for that tenant', async () => {
  const fetchMock = installFetch(tenantListHandler);
  // Simulate a blocked popup: window.open returns null.
  const restoreOpen = stubWindowOpen(() => null);
  try {
    const view = await render();

    const rows = Array.from(view.container.querySelectorAll('tbody tr'));
    const target = TENANTS[0];
    const [button] = buttonsMatching(rows[0], /Inspect devices/);
    assert.ok(button, '"Inspect devices" control should exist on the tenant row');

    await view.click(button);

    // (a) The Tenant Directory view is retained — both rows still rendered.
    const rowsAfter = Array.from(view.container.querySelectorAll('tbody tr'));
    assert.equal(rowsAfter.length, TENANTS.length, 'tenant rows should still be present after a failed open');
    assert.match(view.text(), /Alpha Academy/, 'directory content should be retained');
    assert.match(view.text(), /Bravo Institute/, 'directory content should be retained');

    // (b) An inline, role="alert" error appears for the activated tenant.
    const alerts = Array.from(view.container.querySelectorAll('.tenant-error[role="alert"]'));
    assert.equal(alerts.length, 1, 'exactly one inline device-inspector error should be shown');
    assert.match(alerts[0].textContent || '', /Device Console/, 'error should reference the Device Console');

    // The error lives in the activated tenant's own row.
    const errorRow = alerts[0].closest('tr');
    assert.ok(errorRow, 'the inline error should render inside a tenant row');
    assert.match(errorRow.textContent || '', new RegExp(target.name), 'error should belong to the activated tenant');

    view.unmount();
  } finally {
    restoreOpen();
    fetchMock.restore();
  }
});
