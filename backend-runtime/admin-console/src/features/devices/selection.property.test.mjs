// Feature: device-console-migration, Property 20: Selection eligibility invariant
//
// Validates: Requirements 14.5
//
// Property 20 (design.md): "For any sequence of selection and device-state
// changes, after recomputation the current selection contains no device that is
// non-selectable (deleted, hard banned, or logged out)."
//
// This exercises the REAL pure prune helper (`pruneSelection`) that the
// DeviceConsolePanel calls on every list reload, plus the shared
// `isSelectableDevice` predicate — no re-implementation. Generated device lists
// (a mix of selectable and non-selectable: deleted / hard-banned / logged-out)
// are paired with random initial selection sets (including ids that are NOT in
// the list). After pruning we assert both directions of the invariant:
//   (a) every retained id refers to a currently-present, selectable device; and
//   (b) pruning drops exactly the ineligible/absent ids and nothing more.
//
// The admin console has no configured test runner, so this mirrors the sibling
// task 12.2 test (`apiClient.deviceAdmin.test.mjs`) convention: Node's built-in
// `node --test` runner + `node:assert`, with the TS module graph bundled by the
// repo's esbuild first. `selection.ts` only type-imports `DeviceAdminRecord`
// (erased at build), so the bundle is just the pure helpers + fast-check.

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { pruneSelection, isSelectableDevice } from './selection';

// --- generators ------------------------------------------------------------

// A small, shared id pool so generated selections and device lists overlap
// meaningfully (and so some selected ids are deliberately absent from the list).
const listIdArb = fc.integer({ min: 0, max: 8 }).map((n) => `dev-${n}`);
const selectionIdArb = fc.integer({ min: 0, max: 11 }).map((n) => `dev-${n}`);

// Each "kind" pins one axis of (in)eligibility so every generated list contains
// a realistic mix of selectable and non-selectable devices.
const deviceKindArb = fc.constantFrom(
  'selectable',
  'deleted',
  'hardBanned',
  'loggedOutManual',
  'loggedOutForced',
  'loggedOutAuto',
  'lastActivityLogout',
  'lastActivityForcedLogout',
);

function buildDevice(deviceId, kind) {
  // Baseline: a fully eligible (selectable) device.
  const device = {
    deviceId,
    isDeleted: false,
    isHardBanned: false,
    logoutType: undefined,
    lastActivityType: 'active',
  };
  switch (kind) {
    case 'deleted':
      device.isDeleted = true;
      break;
    case 'hardBanned':
      device.isHardBanned = true;
      break;
    case 'loggedOutManual':
      device.logoutType = 'manual';
      break;
    case 'loggedOutForced':
      device.logoutType = 'forced';
      break;
    case 'loggedOutAuto':
      device.logoutType = 'auto';
      break;
    case 'lastActivityLogout':
      device.lastActivityType = 'logout';
      break;
    case 'lastActivityForcedLogout':
      device.lastActivityType = 'forced_logout';
      break;
    case 'selectable':
    default:
      break;
  }
  return device;
}

const deviceArb = fc
  .record({ deviceId: listIdArb, kind: deviceKindArb })
  .map(({ deviceId, kind }) => buildDevice(deviceId, kind));

const devicesArb = fc.array(deviceArb, { maxLength: 25 });
const selectionArb = fc.array(selectionIdArb, { maxLength: 15 }).map((ids) => new Set(ids));

// --- Property 20 -----------------------------------------------------------

test('Property 20: pruning yields a selection of only currently-selectable, present devices — and drops nothing else', () => {
  fc.assert(
    fc.property(selectionArb, devicesArb, (selected, devices) => {
      // Ground truth: the ids that a selectable, still-present device carries.
      const eligibleIds = new Set(
        devices.filter(isSelectableDevice).map((d) => d.deviceId),
      );

      const pruned = pruneSelection(selected, devices);

      // (a) Invariant — no non-selectable / absent id survives.
      for (const id of pruned) {
        assert.ok(
          eligibleIds.has(id),
          `retained id ${id} is not a currently-selectable, present device`,
        );
      }

      // (b) Exactness — an id is retained iff it was selected AND is eligible;
      //     every ineligible/absent selected id is removed, nothing more.
      for (const id of selected) {
        assert.equal(
          pruned.has(id),
          eligibleIds.has(id),
          `id ${id}: retained=${pruned.has(id)} but eligible=${eligibleIds.has(id)}`,
        );
      }
      // No id can appear in the result unless it was selected to begin with.
      for (const id of pruned) {
        assert.ok(selected.has(id), `retained id ${id} was never selected`);
      }
    }),
    { numRuns: 200 },
  );
});
