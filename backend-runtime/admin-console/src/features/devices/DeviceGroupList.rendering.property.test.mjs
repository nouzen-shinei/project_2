// Feature: device-console-migration, Property 8: Rendering completeness with placeholders
//
// Validates: Requirements 1.4, 6.1, 13.2, 19.2
//
// Property 8 (design.md): every device renders with all of its attribute slots
// present, and any attribute whose value is missing/not-applicable is shown with
// a single consistent placeholder rather than a blank or an `undefined`/`null`
// leak. This renders the REAL DeviceGroupList (the tenant device list surface)
// via `react-dom/server` `renderToStaticMarkup` — no re-implementation — for
// arbitrary lists of devices whose attributes are independently present or
// absent, and asserts on the produced markup.
//
// The admin console has no configured test runner, so this mirrors the sibling
// task 13.7 (`selection.property.test.mjs`) convention: fast-check + Node's
// `node --test`, with the TSX module graph bundled by the repo's esbuild first
// (React kept external for a single instance; a jsdom document parses the static
// markup for structured assertions — see componentTestHarness.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

import { setup } from './componentTestHarness.mjs';

const ctx = await setup();
const { React, staticRender } = ctx;
const { DeviceGroupList, DEVICE_ATTR_PLACEHOLDER } = await import('./DeviceGroupList');

const PLACEHOLDER = DEVICE_ATTR_PLACEHOLDER;

/** True when a value renders as "absent" (missing, null, or blank after trim). */
function blank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

// Attribute pools deliberately mix present values, empty/whitespace values, and
// undefined/null so every slot is exercised in both its present and absent form.
const textPool = fc.constantFrom('macOS', 'Windows 11', 'Ada Laptop', 'Pixel 8', 'Safari', '', '   ', undefined, null);
const typePool = fc.constantFrom('web', 'mobile', 'tablet', undefined, null);
const ipPool = fc.constantFrom('10.0.0.4', '203.0.113.9', '', undefined, null);
const seenPool = fc.constantFrom(
  '2024-06-01T10:00:00.000Z',
  '2023-01-15T08:30:00.000Z',
  'not-a-date',
  '',
  undefined,
  null,
);
const ownerPool = fc.constantFrom('ada@example.com', 'grace@example.com', '', undefined, null);

const deviceSpecArb = fc.record({
  deviceType: typePool,
  deviceName: textPool,
  osName: textPool,
  osVersion: textPool,
  platformOS: textPool,
  browserName: textPool,
  browserVersion: textPool,
  ipAddress: ipPool,
  lastSeen: seenPool,
  ownerEmail: ownerPool,
  isOnline: fc.boolean(),
  isDeleted: fc.boolean(),
  isHardBanned: fc.boolean(),
});

const devicesArb = fc.array(deviceSpecArb, { minLength: 1, maxLength: 5 });

/** Parse static markup into a detached element for structured querying. */
function parse(markup) {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return host;
}

/** The six attribute slots every device row must render (Requirement 1.4). */
const EXPECTED_SLOT_LABELS = ['Type', 'OS', 'Browser', 'IP', 'Last seen', 'Status'];

test('Property 8: every device renders all attribute slots, with a consistent placeholder for missing values', () => {
  fc.assert(
    fc.property(devicesArb, (specs) => {
      // Stable, collision-free ids so each rendered row maps back to its device.
      const devices = specs.map((spec, index) => ({ deviceId: `dev-${index}`, ...spec }));

      const markup = staticRender(
        React.createElement(DeviceGroupList, {
          devices,
          tenantId: 't-1',
          onActionComplete: () => {},
        }),
      );
      const host = parse(markup);

      const rows = Array.from(host.querySelectorAll('.device-row'));
      // Completeness at the list level: every device produces exactly one row.
      assert.equal(rows.length, devices.length, 'every device should render a row');

      // Map each row to its device via the rendered deviceId.
      const rowById = new Map();
      for (const row of rows) {
        const id = row.querySelector('.device-row__main .small-text')?.textContent?.trim();
        rowById.set(id, row);
      }

      for (const device of devices) {
        const row = rowById.get(device.deviceId);
        assert.ok(row, `row for ${device.deviceId} should be present`);

        // Build a label -> rendered-value map for this row's attribute slots.
        const slotEls = Array.from(row.querySelectorAll('.device-row__attrs .device-attr'));
        const slots = new Map();
        for (const el of slotEls) {
          const label = el.querySelector('.device-attr__label')?.textContent?.trim();
          const value = el.querySelector('.device-attr__value')?.textContent ?? '';
          slots.set(label, value.trim());
        }

        // Completeness: all six slots present for every device (Requirement 1.4).
        for (const label of EXPECTED_SLOT_LABELS) {
          assert.ok(slots.has(label), `${device.deviceId}: missing "${label}" slot`);
        }

        // No slot may render empty or leak undefined/null (consistent placeholder).
        for (const label of EXPECTED_SLOT_LABELS) {
          const value = slots.get(label);
          assert.ok(value.length > 0, `${device.deviceId}: "${label}" rendered empty`);
          assert.notEqual(value, 'undefined', `${device.deviceId}: "${label}" leaked undefined`);
          assert.notEqual(value, 'null', `${device.deviceId}: "${label}" leaked null`);
        }

        // Independent oracle for the placeholder rule per slot.
        const typeAbsent = blank(device.deviceType);
        const ipAbsent = blank(device.ipAddress);
        const osAbsent = blank(device.osName) && blank(device.osVersion) && blank(device.platformOS);
        const browserAbsent =
          device.deviceType !== 'web' || (blank(device.browserName) && blank(device.browserVersion));
        const lastSeenAbsent = blank(device.lastSeen) || Number.isNaN(Date.parse(device.lastSeen));

        // Type + IP map straight through the placeholder helper.
        assert.equal(
          slots.get('Type'),
          typeAbsent ? PLACEHOLDER : String(device.deviceType).trim(),
          `${device.deviceId}: Type slot placeholder mismatch`,
        );
        assert.equal(
          slots.get('IP'),
          ipAbsent ? PLACEHOLDER : String(device.ipAddress).trim(),
          `${device.deviceId}: IP slot placeholder mismatch`,
        );

        // OS / Browser / Last seen: placeholder when absent, a real value otherwise.
        for (const [label, absent] of [
          ['OS', osAbsent],
          ['Browser', browserAbsent],
          ['Last seen', lastSeenAbsent],
        ]) {
          const value = slots.get(label);
          if (absent) {
            assert.equal(value, PLACEHOLDER, `${device.deviceId}: "${label}" should show the placeholder`);
          } else {
            assert.notEqual(value, PLACEHOLDER, `${device.deviceId}: "${label}" should show a real value`);
          }
        }

        // Status is always rendered and is never a placeholder.
        assert.notEqual(slots.get('Status'), PLACEHOLDER, `${device.deviceId}: Status must not be a placeholder`);
      }
    }),
    { numRuns: 150 },
  );
});
