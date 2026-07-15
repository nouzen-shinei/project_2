//
// Co-located unit tests for `toObservableDevice` response hygiene
// (device-push-fanout-migration Req 5.4, 7.5). The device-listing endpoint
// projects each recipient device through `toObservableDevice`, which MUST strip
// every push secret and every device network-metadata field before the device
// is serialized to the client. These tests drive the REAL exported function
// against a fully-populated device document (no mocks, no I/O).

import {
  toObservableDevice,
  SENSITIVE_OBSERVABLE_DEVICE_FIELDS,
} from '../deviceFanoutService';

// A device document carrying every push secret and every device network-metadata
// field alongside the benign observable fields a listing consumer relies on.
function fullyPopulatedDeviceDoc(): Record<string, unknown> {
  return {
    // Push secrets — must never leak.
    expoPushToken: 'ExponentPushToken[secret]',
    fcmToken: 'fcm-secret',
    apnsToken: 'apns-secret',
    webPushSubscription: {
      endpoint: 'https://push.example/secret',
      keys: { p256dh: 'p', auth: 'a' },
    },
    // Device network metadata — must never leak (Req 5.4).
    ipAddress: '10.0.0.9',
    networkType: 'wifi',
    carrierName: 'ExampleCarrier',
    userAgent: 'Mozilla/5.0 (secret fingerprint)',
    // Benign observable fields — must be preserved.
    deviceType: 'web',
    deviceName: 'Alice Laptop',
    isOnline: true,
    isDeleted: false,
    tenantIds: ['tenant-a'],
    lastSeen: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('toObservableDevice response hygiene (Req 5.4)', () => {
  it('strips every push secret and device network-metadata field', () => {
    const observable = toObservableDevice('dev-1', fullyPopulatedDeviceDoc(), Date.now());

    for (const field of SENSITIVE_OBSERVABLE_DEVICE_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(observable, field)).toBe(false);
    }
    // Explicitly assert the network-metadata + secret fields by name so a future
    // change to the constant cannot silently reintroduce a leak.
    expect((observable as Record<string, unknown>).expoPushToken).toBeUndefined();
    expect((observable as Record<string, unknown>).fcmToken).toBeUndefined();
    expect((observable as Record<string, unknown>).apnsToken).toBeUndefined();
    expect((observable as Record<string, unknown>).webPushSubscription).toBeUndefined();
    expect((observable as Record<string, unknown>).ipAddress).toBeUndefined();
    expect((observable as Record<string, unknown>).networkType).toBeUndefined();
    expect((observable as Record<string, unknown>).carrierName).toBeUndefined();
    expect((observable as Record<string, unknown>).userAgent).toBeUndefined();
  });

  it('preserves the benign observable fields and forces deviceId/isOnline', () => {
    const observable = toObservableDevice('dev-1', fullyPopulatedDeviceDoc(), Date.now());

    expect(observable.deviceId).toBe('dev-1');
    expect(typeof observable.isOnline).toBe('boolean');
    expect((observable as Record<string, unknown>).deviceType).toBe('web');
    expect((observable as Record<string, unknown>).deviceName).toBe('Alice Laptop');
    expect((observable as Record<string, unknown>).tenantIds).toEqual(['tenant-a']);
  });
});
