// Feature: device-console-migration, Task 17.3 — Client tests for the retired admin
// device-management surface (Requirements 18.1, 18.5).
//
// Two concerns:
//   Test 1 (Req 18.5 — retired route -> "unavailable" view): a stored deep link /
//     saved route that still targets the removed device-management surface is
//     recognised as retired. This predicate is exactly what app/(tabs)/admin.tsx
//     evaluates to decide between rendering the tabs and rendering the
//     "This interface is no longer available" view, so validating the predicate
//     validates the retired-route -> unavailable-view decision.
//   Test 2 (Req 18.1 — no navigation entry point): no path to the removed
//     device-management UI remains — the deleted components are gone and no longer
//     exported from the barrel, and the Admin screen exposes only the users/team
//     tabs (no "notifications" tab / gate).
//
// Approach note (reliably-runnable choice): app/(tabs)/admin.tsx is a heavy screen
// (many React Native / Expo / provider imports) and components/index.ts transitively
// imports React Native. Neither loads under this repo's node-based ts-jest setup
// without an extensive, fragile mock harness. So Test 1 exercises the *real*
// retired-route predicate the screen uses — extracted verbatim into the route-free
// `@/lib/retiredAdminRoute` module during 17.1/17.3 so admin.tsx and this test share
// the same source of truth — and Test 2 asserts the absence of any entry point at the
// filesystem/source level. Both assert against real production artifacts.

import * as fs from 'fs';
import * as path from 'path';

import {
  isRetiredAdminRouteTarget,
  RETIRED_ADMIN_ROUTE_TARGETS,
} from '../../lib/retiredAdminRoute';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADMIN_SCREEN = path.join(REPO_ROOT, 'app', '(tabs)', 'admin.tsx');
const COMPONENTS_BARREL = path.join(REPO_ROOT, 'components', 'index.ts');

// The five admin device-management components deleted in Task 17.2.
const DELETED_DEVICE_COMPONENTS = [
  'AdminNotificationCenter',
  'DeviceActionModal',
  'DeviceDetailsModal',
  'BrowserDeviceModal',
  'AdminNotificationHistoryViewer',
];

// The route/deep-link values that point at the retired surface (per the design).
const RETIRED_VALUES = [
  'notifications',
  'notification',
  'devices',
  'device',
  'device-management',
  'devicemanagement',
];

// ---------------------------------------------------------------------------
// Test 1 — retired route decision (Req 18.5)
// ---------------------------------------------------------------------------
describe('Retired admin route predicate — retired deep links resolve to the unavailable view (Req 18.5)', () => {
  it.each(RETIRED_VALUES)('treats tab="%s" as a retired route', (value) => {
    expect(isRetiredAdminRouteTarget({ tab: value })).toBe(true);
  });

  it.each(RETIRED_VALUES)('treats view="%s" as a retired route', (value) => {
    expect(isRetiredAdminRouteTarget({ view: value })).toBe(true);
  });

  it('matches case-insensitively after trimming surrounding whitespace', () => {
    expect(isRetiredAdminRouteTarget({ view: '  NOTIFICATIONS  ' })).toBe(true);
    expect(isRetiredAdminRouteTarget({ tab: 'Device-Management' })).toBe(true);
    expect(isRetiredAdminRouteTarget({ tab: 'DEVICES' })).toBe(true);
  });

  it('is array-safe (matches expo-router array params by their first entry)', () => {
    expect(isRetiredAdminRouteTarget({ tab: ['devices', 'users'] })).toBe(true);
    expect(isRetiredAdminRouteTarget({ view: ['device'] })).toBe(true);
  });

  it('is retired when either the tab or the view targets the removed surface', () => {
    expect(isRetiredAdminRouteTarget({ tab: 'users', view: 'notifications' })).toBe(true);
    expect(isRetiredAdminRouteTarget({ tab: 'notification', view: 'team' })).toBe(true);
  });

  it.each(['users', 'team'])('does NOT treat the live tab "%s" as retired', (value) => {
    expect(isRetiredAdminRouteTarget({ tab: value })).toBe(false);
  });

  it('does NOT treat empty, undefined, or unrelated params as retired', () => {
    expect(isRetiredAdminRouteTarget({})).toBe(false);
    expect(isRetiredAdminRouteTarget({ tab: undefined, view: undefined })).toBe(false);
    expect(isRetiredAdminRouteTarget({ tab: '' })).toBe(false);
    expect(isRetiredAdminRouteTarget({ tab: [] })).toBe(false);
    expect(isRetiredAdminRouteTarget({ view: 'billing' })).toBe(false);
  });

  it('exposes exactly the documented set of retired route targets', () => {
    expect([...RETIRED_ADMIN_ROUTE_TARGETS].sort()).toEqual([...RETIRED_VALUES].sort());
  });
});

// ---------------------------------------------------------------------------
// Test 2 — no navigation entry point remains (Req 18.1)
// ---------------------------------------------------------------------------
describe('No navigation entry point to the retired device-management UI (Req 18.1)', () => {
  it('the deleted device-management component files no longer exist', () => {
    for (const name of DELETED_DEVICE_COMPONENTS) {
      const filePath = path.join(REPO_ROOT, 'components', `${name}.tsx`);
      expect(fs.existsSync(filePath)).toBe(false);
    }
  });

  it('components/index.ts no longer exports (or references) the deleted components', () => {
    const barrel = fs.readFileSync(COMPONENTS_BARREL, 'utf8');
    for (const name of DELETED_DEVICE_COMPONENTS) {
      expect(barrel).not.toContain(name);
    }
  });

  it('the Admin screen exposes only the users/team tabs (no "notifications" tab or gate)', () => {
    const src = fs.readFileSync(ADMIN_SCREEN, 'utf8');
    // The active-tab union is limited to the two live tabs.
    expect(src).toMatch(/useState<\s*'users'\s*\|\s*'team'\s*>/);
    // No notifications-tab wiring or its former email gate remains.
    expect(src).not.toContain("setActiveTab('notifications')");
    expect(src).not.toContain("activeTab === 'notifications'");
    expect(src).not.toContain('NOTIFICATIONS_TAB_ALLOWED_EMAIL');
  });

  it('the Admin screen guards retired routes via the shared predicate', () => {
    const src = fs.readFileSync(ADMIN_SCREEN, 'utf8');
    expect(src).toContain('isRetiredAdminRouteTarget');
  });
});
