/**
 * Unit test for the `POST /admin/tenants/devices` response-shape stability
 * (Task 4.4 — route layer).
 *
 * Asserts the list endpoint's response envelope is EXACTLY
 * `{ ok, tenantId, counts, devices }` (no extra top-level keys), with
 * `counts` shaped `{ total, online, offline }`, regardless of whether the
 * service resolved the listing via the scoped or the full-scan path — the route
 * relays whatever `listTenantDevices` returns through the same pure
 * counts/search/filter/sort/group pipeline (Req 6.5).
 *
 * Strategy mirrors `deviceAdminRoutes.test.ts`: the service layer is mocked
 * (real pure helpers + error classes preserved) and the real Express app is
 * exercised over an ephemeral listener with an HMAC internal admin token, so no
 * Firebase credentials or emulator are needed.
 *
 * Requirements: 6.5
 */

import crypto from 'crypto';
import type { Server } from 'http';

process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'device-shape-secret';

jest.mock('../deviceAdminService', () => {
  const actual = jest.requireActual('../deviceAdminService');
  return {
    __esModule: true,
    ...actual,
    listTenantDevices: jest.fn(),
  };
});

import { createApp } from '../app';
import * as svc from '../deviceAdminService';

const SECRET = process.env.INTERNAL_API_KEY as string;
const TENANT = 'tenant-shape-xyz';

function signToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function adminToken(): string {
  return signToken({
    sub: 'admin-1',
    email: 'admin@example.com',
    master: true,
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

const asMock = (fn: unknown): jest.Mock => fn as unknown as jest.Mock;

let server: Server;
let base: string;

async function post(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken()}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

beforeAll(async () => {
  const app = createApp({
    overrides: {
      requireTenantMembershipAccess: async (_ctx: any, tenantId: string) => ({
        tenantId,
        role: 'owner',
        membershipId: null,
      }),
      getFirestore: () => ({} as any),
    },
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('server address unavailable');
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /admin/tenants/devices — response envelope shape (Req 6.5)', () => {
  const now = Date.now();
  const devices = [
    { deviceId: 'd1', ownerEmail: 'alice@example.com', deviceType: 'web', lastSeenMs: now - 1_000 },
    { deviceId: 'd2', ownerEmail: 'bob@example.com', deviceType: 'mobile', lastSeenMs: now - 400_000 },
  ];

  it('returns exactly { ok, tenantId, counts, devices } with counts { total, online, offline }', async () => {
    asMock(svc.listTenantDevices).mockResolvedValue(devices);

    const res = await post('/admin/tenants/devices', { tenantId: TENANT });

    expect(res.status).toBe(200);
    // Exactly these four top-level keys — no more, no less.
    expect(Object.keys(res.body).sort()).toEqual(['counts', 'devices', 'ok', 'tenantId']);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBe(TENANT);

    // Counts envelope is unchanged.
    expect(Object.keys(res.body.counts).sort()).toEqual(['offline', 'online', 'total']);
    expect(res.body.counts.total).toBe(2);
    expect(res.body.counts.online + res.body.counts.offline).toBe(res.body.counts.total);

    // Devices relayed through (both in-tenant devices present).
    expect(res.body.devices.map((d: any) => d.deviceId).sort()).toEqual(['d1', 'd2']);

    // The route delegates scoping to the service (which selects scoped vs
    // full-scan internally); it is called once with the trimmed tenant id.
    expect(asMock(svc.listTenantDevices)).toHaveBeenCalledWith(TENANT);
  });

  it('response shape is identical whatever record set the service returns (empty listing)', async () => {
    asMock(svc.listTenantDevices).mockResolvedValue([]);

    const res = await post('/admin/tenants/devices', { tenantId: TENANT });

    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['counts', 'devices', 'ok', 'tenantId']);
    expect(res.body.devices).toEqual([]);
    expect(res.body.counts).toEqual({ total: 0, online: 0, offline: 0 });
  });
});
