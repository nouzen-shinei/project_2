// Feature: device-console-migration, Task 9.7: Route-surface smoke test
// Validates: Requirements 15.1
//
// Asserts that all 13 Device Admin API paths are mounted on the Express app
// returned by createApp(). This is a route-surface smoke test: it inspects the
// registered router stack so we know each path resolves to a real handler
// rather than falling through to the catch-all 404 for unknown routes.

// Ensure createApp() runs in test mode (no schedulers / event-loop monitor).
process.env.TEST_MODE = '1';

import { createApp } from '../app';

/** All 13 Device Admin API endpoints, all mounted as POST. */
const EXPECTED_DEVICE_ROUTES: ReadonlyArray<string> = [
  'POST /admin/tenants/devices', // #1 list/search/filter/sort/counts
  'POST /admin/tenants/devices/detail', // #2 detail
  'POST /admin/tenants/devices/force-logout', // #3 force logout one device
  'POST /admin/tenants/devices/force-logout-all', // #4 force logout all of a user
  'POST /admin/tenants/devices/bulk/force-logout', // #5 bulk force logout
  'POST /admin/tenants/devices/ban', // #6 ban
  'POST /admin/tenants/devices/unban', // #7 unban
  'POST /admin/tenants/devices/delete', // #8 soft delete
  'POST /admin/tenants/devices/restore', // #9 restore
  'POST /admin/tenants/devices/permanent-delete', // #10 permanent delete
  'POST /admin/tenants/devices/notify', // #11 notify
  'POST /admin/tenants/devices/history', // #12 history
  'POST /admin/tenants/devices/timeline', // #13 timeline
];

/**
 * Walks the Express router stack and returns the set of registered
 * `"<METHOD> <path>"` route signatures.
 */
function collectRegisteredRoutes(app: any): Set<string> {
  const routes = new Set<string>();
  const stack: any[] = app?._router?.stack ?? [];
  for (const layer of stack) {
    const route = layer?.route;
    if (!route || typeof route.path !== 'string') {
      continue;
    }
    const methods = route.methods ?? {};
    for (const method of Object.keys(methods)) {
      if (methods[method]) {
        routes.add(`${method.toUpperCase()} ${route.path}`);
      }
    }
  }
  return routes;
}

describe('Device Admin API route surface', () => {
  let registeredRoutes: Set<string>;

  beforeAll(() => {
    const app = createApp();
    registeredRoutes = collectRegisteredRoutes(app);
  });

  it('exposes a non-empty router stack', () => {
    // Sanity check: if this is empty, our introspection assumptions are wrong
    // and the per-route assertions below would pass/fail for the wrong reason.
    expect(registeredRoutes.size).toBeGreaterThan(0);
  });

  it.each(EXPECTED_DEVICE_ROUTES)('mounts %s', (signature) => {
    expect(registeredRoutes.has(signature)).toBe(true);
  });

  it('mounts all 13 Device Admin API paths', () => {
    const missing = EXPECTED_DEVICE_ROUTES.filter((sig) => !registeredRoutes.has(sig));
    expect(missing).toEqual([]);
    expect(EXPECTED_DEVICE_ROUTES.length).toBe(13);
  });

  it('registers each Device Admin path only as POST', () => {
    // Every /admin/tenants/devices* path should be reachable via POST and must
    // not be accidentally registered under a different verb.
    const otherVerbDeviceRoutes = Array.from(registeredRoutes).filter((sig) => {
      const [method, path] = sig.split(' ');
      return path.startsWith('/admin/tenants/devices') && method !== 'POST';
    });
    expect(otherVerbDeviceRoutes).toEqual([]);
  });
});
