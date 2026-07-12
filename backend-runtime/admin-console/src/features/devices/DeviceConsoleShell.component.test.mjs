// Feature: device-console-migration, Task 14.2 — component tests for the way
// the Device Console is wired into the console shell (App.tsx): the `devices`
// tab and the `?view=device-inspector&tenantId=…` deep link.
//
// These render the REAL default-exported `App` through the shared harness
// (componentTestHarness.mjs): a single jsdom document, `createRoot` + `act`
// mounts that run mount effects, and a mocked global `fetch` so no network is
// hit. That means the actual `App` URL parsing, `TAB_CONFIG` wiring, and the
// standalone `isDeviceInspectorView` branch all execute exactly as they do in
// the browser.
//
// Controlling App's initial URL: `App` reads `window.location.search` at render
// time (the `?tab=` parser in the `activeTab` initialiser and the
// `isDeviceInspectorView` / `deviceInspectorTenantId` branch). jsdom implements
// the History API, so `window.history.replaceState` rewrites the current URL —
// and therefore `window.location.search` — before we mount `App`. No harness
// fork is needed; we just set the location up front.
//
// Coverage:
//   • Requirement 1.1 — the `devices` tab mounts the Device Console panel.
//   • Requirement 2.3 — `?view=device-inspector&tenantId=t-xyz` renders the
//     standalone panel scoped to that tenant (and fetches scoped to `t-xyz`).

import test from 'node:test';
import assert from 'node:assert/strict';

import { setup, installFetch } from './componentTestHarness.mjs';

const ctx = await setup();
const { React, mount, flush } = ctx;
const App = (await import('../../App')).default;

const DEVICES_PATH = '/admin/tenants/devices';

/**
 * Set the current URL (and thus `window.location.search`) before mounting App.
 * jsdom supports `history.replaceState`; App reads the query only at render, so
 * this fully controls which tab / view App resolves on its first render.
 */
function setUrl(relativeUrl) {
  window.history.replaceState({}, '', relativeUrl);
}

/** Flush pending effects/microtasks a few times so hydration + the panel's
 *  mount fetch settle. */
async function settle(times = 4) {
  for (let i = 0; i < times; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await flush();
  }
}

function emptyDeviceList(tenantId) {
  return {
    ok: true,
    tenantId: tenantId ?? null,
    counts: { total: 0, online: 0, offline: 0 },
    devices: [],
  };
}

/**
 * A benign fetch handler: it answers the device-list endpoint deterministically
 * (echoing the requested tenantId) and returns an empty `{ ok: true }` for any
 * other path App or its children might touch on mount, so nothing throws.
 */
function benignHandler() {
  return (path, init) => {
    if (path === DEVICES_PATH) {
      let tenantId = null;
      try {
        tenantId = JSON.parse(init?.body || '{}').tenantId ?? null;
      } catch {
        /* body not JSON — leave tenantId null */
      }
      return { status: 200, data: emptyDeviceList(tenantId) };
    }
    return { status: 200, data: { ok: true } };
  };
}

// --- Requirement 1.1 — the `devices` tab mounts the Device Console panel ------

test('Requirement 1.1: the `devices` tab mounts the Device Console panel', async () => {
  setUrl('/?tab=devices');
  const fetchMock = installFetch(benignHandler());
  try {
    const view = await mount(React.createElement(App));
    await settle();

    // The `devices` tab is the resolved active tab (its chip is marked active).
    const activeChips = Array.from(view.container.querySelectorAll('.tab-chip.active')).map(
      (b) => (b.textContent || '').trim(),
    );
    assert.ok(
      activeChips.some((t) => /Device Console/.test(t)),
      'the devices tab should be the active tab',
    );

    // The Device Console panel itself is mounted under the tab. The panel's
    // "No tenant is selected" guidance is unique to the panel (the tab renders
    // the panel without a tenantId; a tenant is scoped via the Tenant Directory
    // deep link), so its presence proves the real panel — not just the tab
    // label — rendered.
    assert.match(view.text(), /Device Console/);
    assert.match(
      view.text(),
      /No tenant is selected/,
      'the mounted Device Console panel should render its no-tenant guidance',
    );

    // The unscoped tab view issues no device-list fetch (there is no tenant to
    // scope to yet); the scoped fetch is exercised by the deep-link test below.
    assert.equal(
      fetchMock.calls.filter((c) => c.path === DEVICES_PATH).length,
      0,
      'the tab view should not fetch a device list until a tenant is scoped',
    );

    view.unmount();
  } finally {
    fetchMock.restore();
  }
});

// --- Requirement 2.3 — the deep link renders the scoped standalone panel ------

test('Requirement 2.3: `?view=device-inspector&tenantId=t-xyz` renders the scoped standalone panel', async () => {
  setUrl('/?view=device-inspector&tenantId=t-xyz');
  const fetchMock = installFetch(benignHandler());
  try {
    const view = await mount(React.createElement(App));
    await settle();

    const text = view.text();

    // The Device Console panel renders, scoped to the deep-link tenant.
    assert.match(text, /Device Console/, 'the Device Console panel heading should be present');
    assert.match(text, /Tenant:\s*t-xyz/, 'the panel should be scoped to the deep-link tenant');

    // Standalone deep-link view: the console sidebar tab rail is NOT rendered
    // (mirrors the membership-inspector single-column shell).
    const consoleNav = view.container.querySelector('nav.tab-rail[aria-label="Console sections"]');
    assert.equal(consoleNav, null, 'the standalone deep-link view should omit the console tab rail');

    // The panel fetched the device list scoped to the deep-link tenant.
    const listCalls = fetchMock.calls.filter((c) => c.path === DEVICES_PATH);
    assert.ok(listCalls.length >= 1, 'the device list endpoint should be called for the scoped tenant');
    const body = JSON.parse(listCalls[0].init.body);
    assert.equal(body.tenantId, 't-xyz', 'the list fetch should be scoped to the deep-link tenant');

    view.unmount();
  } finally {
    fetchMock.restore();
  }
});
