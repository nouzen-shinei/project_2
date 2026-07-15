// Feature: device-push-fanout-migration — property suite for the pure Fanout_Result assembly
//
// Co-located property tests for `assembleFanoutResult` and
// `serializeFanoutResponse` (design "Components §2 step 6", Properties 11–14).
// Each property drives the REAL exported functions against generated outcome
// inputs (no mocks, no I/O). Every `fc.assert` runs at least NUM_RUNS (100)
// iterations (Req 11.6), and each test asserts its predicate executed >= NUM_RUNS
// times so the run count is verifiable.

import * as fc from 'fast-check';

import {
  assembleFanoutResult,
  serializeFanoutResponse,
  FANOUT_RESULT_KEYS,
  type DeviceNotificationFanoutResult,
  type FanoutResultInput,
} from '../deviceFanoutService';

const NUM_RUNS = 100;

// The ten fields the DeviceNotificationFanoutResult contract guarantees. Kept
// local (rather than importing FANOUT_RESULT_KEYS) so the test independently
// pins the contract; a mismatch with the source list is itself a failure.
const EXPECTED_KEYS = [
  'success',
  'failed',
  'deliverableDeviceCount',
  'onlineDeliverableCount',
  'presenceDeliveredCount',
  'pushAcceptedCount',
  'mobilePushAcceptedCount',
  'webPushAcceptedCount',
  'staleWebPushSubscriptionsCleaned',
  'deduplicatedWebPushSubscriptionsCleaned',
].sort();

// Secret-looking fields that must NEVER appear in a serialized response — push
// tokens, web-push endpoints, and device network metadata (Req 5.4).
const FORBIDDEN_KEYS = [
  'expoPushToken',
  'fcmToken',
  'apnsToken',
  'webPushSubscription',
  'endpoint',
  'webPushEndpoint',
  'ipAddress',
  'userAgent',
  'deviceId',
  'keys',
];

// Finite, non-negative counts — the realistic outcome numbers the orchestrator
// produces. Used by the reconciliation (13) and suppression (14) properties.
const countArb = fc.integer({ min: 0, max: 250 });

// A "messy" numeric arbitrary that also yields non-finite values and undefined,
// used to prove `assembleFanoutResult` always emits finite numbers (Property 12).
const messyNumberArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: -50, max: 250 }),
  fc.double(),
  fc.constantFrom(
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    undefined as unknown as number
  )
);

const finiteInputArb: fc.Arbitrary<FanoutResultInput> = fc.record({
  suppressed: fc.boolean(),
  deliverableDeviceCount: countArb,
  onlineDeliverableCount: countArb,
  presenceDeliveredCount: countArb,
  mobileAccepted: countArb,
  webPushAccepted: countArb,
  failed: countArb,
  staleCleaned: countArb,
  duplicatesCleaned: countArb,
});

const messyInputArb: fc.Arbitrary<FanoutResultInput> = fc.record({
  suppressed: fc.boolean(),
  deliverableDeviceCount: messyNumberArb,
  onlineDeliverableCount: messyNumberArb,
  presenceDeliveredCount: messyNumberArb,
  mobileAccepted: messyNumberArb,
  webPushAccepted: messyNumberArb,
  failed: messyNumberArb,
  staleCleaned: messyNumberArb,
  duplicatesCleaned: messyNumberArb,
});

describe('deviceFanoutService — Fanout_Result assembly properties', () => {
  it('Property 11: the response never contains push secrets or device network metadata', () => {
    // Feature: device-push-fanout-migration, Property 11: The response never contains push secrets or device network metadata
    let runs = 0;
    fc.assert(
      fc.property(finiteInputArb, fc.string(), fc.string(), (input, secretToken, secretEndpoint) => {
        runs += 1;
        const result = assembleFanoutResult(input);

        // (a) A clean assembled result serializes to exactly the ten numeric keys.
        const clean = serializeFanoutResponse(result);
        expect(Object.keys(clean).sort()).toEqual(EXPECTED_KEYS);

        // (b) Even when the result object is polluted with secret-looking fields,
        // serialize copies ONLY the ten known fields, stripping every extra.
        const polluted = {
          ...result,
          expoPushToken: secretToken,
          fcmToken: secretToken,
          apnsToken: secretToken,
          webPushSubscription: { endpoint: secretEndpoint, keys: { p256dh: 'x', auth: 'y' } },
          endpoint: secretEndpoint,
          webPushEndpoint: secretEndpoint,
          ipAddress: '203.0.113.7',
          userAgent: 'Mozilla/5.0',
          deviceId: 'device-123',
        } as unknown as DeviceNotificationFanoutResult;

        const serialized = serializeFanoutResponse(polluted);
        const keys = Object.keys(serialized);
        expect(keys.sort()).toEqual(EXPECTED_KEYS);
        for (const forbidden of FORBIDDEN_KEYS) {
          expect(Object.prototype.hasOwnProperty.call(serialized, forbidden)).toBe(false);
        }
        // Every emitted value is a plain finite number — no nested objects/strings.
        for (const key of keys) {
          expect(typeof (serialized as Record<string, unknown>)[key]).toBe('number');
        }
      }),
      { numRuns: NUM_RUNS }
    );
    // FANOUT_RESULT_KEYS is the source-of-truth key list; it must match the ten.
    expect([...FANOUT_RESULT_KEYS].sort()).toEqual(EXPECTED_KEYS);
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 12: the Fanout_Result shape is complete and flag-invariant', () => {
    // Feature: device-push-fanout-migration, Property 12: The Fanout_Result shape is complete and flag-invariant
    let runs = 0;
    fc.assert(
      fc.property(messyInputArb, (input) => {
        runs += 1;
        const result = assembleFanoutResult(input);
        // All ten fields present, and every one is a finite number regardless of
        // the (possibly non-finite/undefined) inputs and either suppressed state.
        expect(Object.keys(result).sort()).toEqual(EXPECTED_KEYS);
        for (const key of EXPECTED_KEYS) {
          const value = (result as Record<string, unknown>)[key];
          expect(typeof value).toBe('number');
          expect(Number.isFinite(value as number)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 13: push and cleanup counts reconcile with outcomes', () => {
    // Feature: device-push-fanout-migration, Property 13: Push and cleanup counts reconcile with outcomes
    let runs = 0;
    fc.assert(
      fc.property(finiteInputArb, (rawInput) => {
        runs += 1;
        // This property is about NON-suppressed outcomes.
        const input: FanoutResultInput = { ...rawInput, suppressed: false };
        const result = assembleFanoutResult(input);

        // pushAcceptedCount splits exactly across the two push channels.
        expect(result.pushAcceptedCount).toBe(
          result.mobilePushAcceptedCount + result.webPushAcceptedCount
        );
        // The two channel counts pass through from the delivery pass.
        expect(result.mobilePushAcceptedCount).toBe(input.mobileAccepted);
        expect(result.webPushAcceptedCount).toBe(input.webPushAccepted);
        // Cleanup counts equal the input stale/duplicate cleanup totals.
        expect(result.staleWebPushSubscriptionsCleaned).toBe(input.staleCleaned);
        expect(result.deduplicatedWebPushSubscriptionsCleaned).toBe(input.duplicatesCleaned);
        // Success = presence + push (client parity).
        expect(result.success).toBe(input.presenceDeliveredCount + result.pushAcceptedCount);
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });

  it('Property 14: suppression zeroes every count except cleanup counts', () => {
    // Feature: device-push-fanout-migration, Property 14: Suppression zeroes every count except cleanup counts
    let runs = 0;
    fc.assert(
      fc.property(finiteInputArb, (rawInput) => {
        runs += 1;
        const input: FanoutResultInput = { ...rawInput, suppressed: true };
        const result = assembleFanoutResult(input);

        // Everything except the two cleanup counts is forced to zero.
        expect(result.success).toBe(0);
        expect(result.failed).toBe(0);
        expect(result.deliverableDeviceCount).toBe(0);
        expect(result.onlineDeliverableCount).toBe(0);
        expect(result.presenceDeliveredCount).toBe(0);
        expect(result.pushAcceptedCount).toBe(0);
        expect(result.mobilePushAcceptedCount).toBe(0);
        expect(result.webPushAcceptedCount).toBe(0);

        // The cleanup counts still reflect the Web_Push_Cleanup outcome.
        expect(result.staleWebPushSubscriptionsCleaned).toBe(input.staleCleaned);
        expect(result.deduplicatedWebPushSubscriptionsCleaned).toBe(input.duplicatesCleaned);
      }),
      { numRuns: NUM_RUNS }
    );
    expect(runs).toBeGreaterThanOrEqual(NUM_RUNS);
  });
});
