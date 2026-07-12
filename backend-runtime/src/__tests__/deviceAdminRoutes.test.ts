/**
 * Unit tests for the Device Admin API route layer (Task 9.6).
 *
 * Exercises request validation, happy-path success shapes, and the exact
 * code -> status error mapping documented in the design's Error Handling table
 * for all 13 `/admin/tenants/devices/...` endpoints registered in
 * `backend-runtime/src/app.ts`.
 *
 * Strategy (fast unit tests, no emulator):
 *   - The service layer (`deviceAdminService`) is mocked: its IO / orchestrator
 *     functions are replaced with `jest.fn()`s while the real pure helpers
 *     (`computeCounts`, `matchesSearch`, `matchesFilter`, `sortAndGroup`,
 *     `validate*`) and the real typed error classes are preserved via
 *     `requireActual` so the routes' own mapping (`instanceof DeviceAdminError`)
 *     works unchanged.
 *   - The Express app is exercised over an ephemeral `http` listener with
 *     `fetch`, so no HTTP client dependency is added.
 *   - Auth uses HMAC-signed internal tokens (same scheme as the existing
 *     `tests/*.test.mjs` guard suites) so no Firebase Admin credentials are
 *     needed. An admin caller is an internal token carrying `master: true`
 *     (maps to `authContext.tokenType === 'master'`); a non-admin caller is a
 *     plain internal token (`isGlobalAdmin === false`).
 *   - The shared per-request tenant guard is overridden to succeed so it is the
 *     route's OWN authorization / validation / error mapping that is asserted.
 *
 * Requirements: 15.2, 15.3, 15.4, 16.2
 */

import crypto from 'crypto';
import type { Server } from 'http';

// Must be set before `createApp` (and the auth middleware) reads them.
process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'device-routes-secret';

// Stub the service IO/orchestrators; keep the real pure helpers + error classes.
jest.mock('../deviceAdminService', () => {
  const actual = jest.requireActual('../deviceAdminService');
  return {
    __esModule: true,
    ...actual,
    listTenantDevices: jest.fn(),
    fetchDeviceDetail: jest.fn(),
    fetchHistory: jest.fn(),
    fetchTimeline: jest.fn(),
    forceLogout: jest.fn(),
    forceLogoutAll: jest.fn(),
    bulkForceLogout: jest.fn(),
    ban: jest.fn(),
    unban: jest.fn(),
    softDelete: jest.fn(),
    restore: jest.fn(),
    permanentDelete: jest.fn(),
    notify: jest.fn(),
  };
});

import { createApp } from '../app';
import * as svc from '../deviceAdminService';
import {
  DeviceNotFoundError,
  TenantScopeError,
  DeviceConflictError,
  SignalWriteError,
  DeleteRolledBackError,
  ForceLogoutAllError,
  AuditWriteError,
} from '../deviceAdminService';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const SECRET = process.env.INTERNAL_API_KEY as string;
const TENANT = 'tenant-abc123';
const EMAIL = 'owner@example.com';
const DEVICE = 'device-1';
const REASON = 'policy violation';

/** Sign an internal token (HMAC over a base64url JSON payload). */
function signToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Admin caller: internal token with `master: true` + an email (avoids Firebase). */
function adminToken(): string {
  return signToken({
    sub: 'admin-1',
    email: 'admin@example.com',
    master: true,
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

/** Authenticated but non-admin caller (`isGlobalAdmin === false`). */
function nonAdminToken(): string {
  return signToken({
    sub: 'user-1',
    email: 'user@example.com',
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

let server: Server;
let base: string;

/** POST JSON and return `{ status, body }` (body is `null` for non-JSON responses). */
async function post(
  path: string,
  body: unknown,
  token: string | null = adminToken()
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers,
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

/** Cast a mocked service export to a jest.Mock for `.mock*` helpers. */
const asMock = (fn: unknown): jest.Mock => fn as unknown as jest.Mock;

beforeAll(async () => {
  const app = createApp({
    overrides: {
      // Let the shared per-request tenant guard pass without Firestore so the
      // route's own auth/validation/mapping is what these tests exercise.
      requireTenantMembershipAccess: async (_ctx: any, tenantId: string) => ({
        tenantId,
        role: 'owner',
        membershipId: null,
      }),
      // The guard reads a Firestore handle before its (master/internal) billing
      // short-circuit; a harmless stub keeps it from touching real Firestore.
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

// A descriptor per endpoint used by the cross-cutting auth + validation loops.
// `validBody` passes zod (and carries a resolvable `tenantId` for the guard);
// `invalidBody` carries a resolvable `tenantId` but violates the route schema.
interface EndpointCase {
  name: string;
  path: string;
  validBody: Record<string, unknown>;
  invalidBody: Record<string, unknown>;
}

const ENDPOINTS: EndpointCase[] = [
  {
    name: 'list',
    path: '/admin/tenants/devices',
    validBody: { tenantId: TENANT },
    invalidBody: { tenantId: TENANT, filter: 'not-a-filter' },
  },
  {
    name: 'detail',
    path: '/admin/tenants/devices/detail',
    validBody: { tenantId: TENANT, email: EMAIL, deviceId: DEVICE },
    invalidBody: { tenantId: TENANT, email: 'not-an-email', deviceId: DEVICE },
  },
  {
    name: 'history',
    path: '/admin/tenants/devices/history',
    validBody: { tenantId: TENANT },
    invalidBody: { tenantId: TENANT, limit: -5 },
  },
  {
    name: 'timeline',
    path: '/admin/tenants/devices/timeline',
    validBody: { tenantId: TENANT, email: EMAIL, deviceId: DEVICE },
    invalidBody: { tenantId: TENANT, email: 'not-an-email', deviceId: DEVICE },
  },
  {
    name: 'force-logout',
    path: '/admin/tenants/devices/force-logout',
    validBody: { tenantId: TENANT, email: EMAIL, deviceId: DEVICE, reason: REASON },
    invalidBody: { tenantId: TENANT, email: 'not-an-email', deviceId: DEVICE },
  },
  {
    name: 'ban',
    path: '/admin/tenants/devices/ban',
    validBody: { tenantId: TENANT, email: EMAIL, deviceId: DEVICE, reason: REASON },
    invalidBody: { tenantId: TENANT, email: 'not-an-email', deviceId: DEVICE, reason: REASON },
  },
  {
    name: 'unban',
    path: '/admin/tenants/devices/unban',
    validBody: { tenantId: TENANT, email: EMAIL, deviceId: DEVICE },
    invalidBody: { tenantId: TENANT, email: 'not-an-email', deviceId: DEVICE },
  },
  {
    name: 'delete',
    path: '/admin/tenants/devices/delete',
    validBody: { tenantId: TENANT, email: EMAIL, deviceId: DEVICE, reason: REASON },
    invalidBody: { tenantId: TENANT, email: EMAIL }, // missing deviceId
  },
  {
    name: 'restore',
    path: '/admin/tenants/devices/restore',
    validBody: { tenantId: TENANT, email: EMAIL, deviceId: DEVICE },
    invalidBody: { tenantId: TENANT, email: EMAIL }, // missing deviceId
  },
  {
    name: 'permanent-delete',
    path: '/admin/tenants/devices/permanent-delete',
    validBody: { tenantId: TENANT, email: EMAIL, deviceId: DEVICE, reason: REASON },
    invalidBody: { tenantId: TENANT, email: EMAIL }, // missing deviceId
  },
  {
    name: 'force-logout-all',
    path: '/admin/tenants/devices/force-logout-all',
    validBody: { tenantId: TENANT, email: EMAIL },
    invalidBody: { tenantId: TENANT, email: 'not-an-email' },
  },
  {
    name: 'bulk-force-logout',
    path: '/admin/tenants/devices/bulk/force-logout',
    validBody: { tenantId: TENANT, targets: [{ email: EMAIL, deviceId: DEVICE }] },
    invalidBody: { tenantId: TENANT, targets: [{ email: 'not-an-email', deviceId: DEVICE }] },
  },
  {
    name: 'notify',
    path: '/admin/tenants/devices/notify',
    validBody: {
      tenantId: TENANT,
      title: 'Heads up',
      body: 'Please re-authenticate',
      targets: [{ email: EMAIL, deviceId: DEVICE }],
    },
    invalidBody: {
      tenantId: TENANT,
      title: 'Heads up',
      body: 'Please re-authenticate',
      targets: [{ email: 'not-an-email', deviceId: DEVICE }],
    },
  },
];

// ---------------------------------------------------------------------------
// Authorization (Requirement 16.2 / design Property 16 route portion)
// ---------------------------------------------------------------------------

describe('authorization gate (every endpoint)', () => {
  it.each(ENDPOINTS)(
    '$name -> 403 not_authorized for an authenticated non-admin caller (no service call)',
    async ({ path, validBody }) => {
      const res = await post(path, validBody, nonAdminToken());
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'not_authorized' });
      // No orchestration is attempted when authorization is denied.
      expect(asMock(svc.forceLogout)).not.toHaveBeenCalled();
      expect(asMock(svc.notify)).not.toHaveBeenCalled();
      expect(asMock(svc.listTenantDevices)).not.toHaveBeenCalled();
    }
  );

  it.each(ENDPOINTS)(
    '$name -> 401 when no bearer token is presented (auth middleware pre-empts)',
    async ({ path, validBody }) => {
      const res = await post(path, validBody, null);
      // The shared auth middleware rejects missing credentials with 401; the
      // Console treats 401 and 403 identically as "authorization denied".
      expect(res.status).toBe(401);
    }
  );
});

// ---------------------------------------------------------------------------
// Body validation -> 400 validation_failed (Requirements 15.2, 15.3)
// ---------------------------------------------------------------------------

describe('request validation (every endpoint)', () => {
  it.each(ENDPOINTS)(
    '$name -> 400 validation_failed for a malformed body (no service call)',
    async ({ path, invalidBody }) => {
      const res = await post(path, invalidBody);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('validation_failed');
      expect(Array.isArray(res.body.issues)).toBe(true);
      // A rejected request performs no orchestration (no state mutation).
      expect(asMock(svc.forceLogout)).not.toHaveBeenCalled();
      expect(asMock(svc.ban)).not.toHaveBeenCalled();
      expect(asMock(svc.notify)).not.toHaveBeenCalled();
    }
  );
});

// ---------------------------------------------------------------------------
// Happy paths per endpoint (Requirement 15.4)
// ---------------------------------------------------------------------------

describe('happy paths (Requirement 15.4)', () => {
  it('#1 list -> 200 with tenant, counts, and devices', async () => {
    asMock(svc.listTenantDevices).mockResolvedValue([
      { deviceId: DEVICE, ownerEmail: EMAIL, deviceType: 'web', lastSeenMs: Date.now() },
    ]);

    const res = await post('/admin/tenants/devices', { tenantId: TENANT });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.tenantId).toBe(TENANT);
    // Real `computeCounts` runs over the stubbed list (online + offline = total).
    expect(res.body.counts).toEqual({ total: 1, online: 1, offline: 0 });
    expect(res.body.devices).toHaveLength(1);
    expect(res.body.devices[0].deviceId).toBe(DEVICE);
    expect(asMock(svc.listTenantDevices)).toHaveBeenCalledWith(TENANT);
  });

  it('#2 detail -> 200 with the projected device', async () => {
    asMock(svc.fetchDeviceDetail).mockResolvedValue({ deviceId: DEVICE, deviceType: 'mobile' });

    const res = await post('/admin/tenants/devices/detail', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, device: { deviceId: DEVICE, deviceType: 'mobile' } });
    expect(asMock(svc.fetchDeviceDetail)).toHaveBeenCalledWith({
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
  });

  it('#12 history -> 200 with entries + hasMore (nextCursor omitted when absent)', async () => {
    asMock(svc.fetchHistory).mockResolvedValue({ entries: [{ id: 'a' }], hasMore: false });

    const res = await post('/admin/tenants/devices/history', { tenantId: TENANT });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entries).toEqual([{ id: 'a' }]);
    expect(res.body.hasMore).toBe(false);
    expect(res.body).not.toHaveProperty('nextCursor');
  });

  it('#12 history -> 200 includes nextCursor when the service returns one', async () => {
    asMock(svc.fetchHistory).mockResolvedValue({
      entries: [{ id: 'a' }],
      hasMore: true,
      nextCursor: 'cursor-1',
    });

    const res = await post('/admin/tenants/devices/history', { tenantId: TENANT, limit: 1 });

    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextCursor).toBe('cursor-1');
  });

  it('#13 timeline -> 200 with ordered entries', async () => {
    asMock(svc.fetchTimeline).mockResolvedValue({ entries: [{ id: 'a' }, { id: 'b' }] });

    const res = await post('/admin/tenants/devices/timeline', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, entries: [{ id: 'a' }, { id: 'b' }] });
  });

  it('#3 force-logout -> 200 { ok: true } and forwards the resolved actor', async () => {
    asMock(svc.forceLogout).mockResolvedValue({ ok: true });

    const res = await post('/admin/tenants/devices/force-logout', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(asMock(svc.forceLogout)).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        email: EMAIL,
        deviceId: DEVICE,
        reason: REASON,
        actor: expect.objectContaining({ id: 'admin-1', email: 'admin@example.com' }),
      })
    );
  });

  it('#6 ban -> 200 { ok, banId }', async () => {
    asMock(svc.ban).mockResolvedValue({ ok: true, banId: 'ban-123' });

    const res = await post('/admin/tenants/devices/ban', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, banId: 'ban-123' });
  });

  it('#6 ban -> 200 with a valid future expiration', async () => {
    asMock(svc.ban).mockResolvedValue({ ok: true, banId: 'ban-exp' });
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const res = await post('/admin/tenants/devices/ban', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
      expiresAt: future,
    });

    expect(res.status).toBe(200);
    expect(res.body.banId).toBe('ban-exp');
    expect(asMock(svc.ban)).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: future })
    );
  });

  it('#7 unban -> 200 { ok: true }', async () => {
    asMock(svc.unban).mockResolvedValue({ ok: true });
    const res = await post('/admin/tenants/devices/unban', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('#8 delete -> 200 { ok: true }', async () => {
    asMock(svc.softDelete).mockResolvedValue({ ok: true });
    const res = await post('/admin/tenants/devices/delete', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('#9 restore -> 200 { ok: true }', async () => {
    asMock(svc.restore).mockResolvedValue({ ok: true });
    const res = await post('/admin/tenants/devices/restore', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('#10 permanent-delete -> 200 { ok: true }', async () => {
    asMock(svc.permanentDelete).mockResolvedValue({ ok: true });
    const res = await post('/admin/tenants/devices/permanent-delete', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('#4 force-logout-all -> 200 { ok, affected }', async () => {
    asMock(svc.forceLogoutAll).mockResolvedValue({ ok: true, affected: 3 });
    const res = await post('/admin/tenants/devices/force-logout-all', {
      tenantId: TENANT,
      email: EMAIL,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, affected: 3 });
  });

  it('#5 bulk force-logout -> 200 { ok, succeeded, failed, results }', async () => {
    asMock(svc.bulkForceLogout).mockResolvedValue({
      succeeded: 1,
      failed: 0,
      results: [{ deviceId: DEVICE, email: EMAIL, ok: true }],
    });
    const res = await post('/admin/tenants/devices/bulk/force-logout', {
      tenantId: TENANT,
      targets: [{ email: EMAIL, deviceId: DEVICE }],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.succeeded).toBe(1);
    expect(res.body.failed).toBe(0);
    expect(res.body.results).toHaveLength(1);
  });

  it('#11 notify -> 200 { ok, successful, failed, results }', async () => {
    asMock(svc.notify).mockResolvedValue({
      successful: 1,
      failed: 0,
      results: [{ deviceId: DEVICE, email: EMAIL, ok: true }],
    });
    const res = await post('/admin/tenants/devices/notify', {
      tenantId: TENANT,
      title: 'Heads up',
      body: 'Please re-authenticate',
      targets: [{ email: EMAIL, deviceId: DEVICE }],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.successful).toBe(1);
    expect(res.body.failed).toBe(0);
  });

  it('#11 notify -> 200 with all-failed counts when the push service is unavailable', async () => {
    // Per the Error Handling table, push-service-unavailable is a 200 response
    // with `failed === targets`, not an HTTP error.
    asMock(svc.notify).mockResolvedValue({
      successful: 0,
      failed: 2,
      results: [
        { deviceId: 'd1', email: EMAIL, ok: false, error: 'push_unavailable' },
        { deviceId: 'd2', email: EMAIL, ok: false, error: 'push_unavailable' },
      ],
    });
    const res = await post('/admin/tenants/devices/notify', {
      tenantId: TENANT,
      title: 'Heads up',
      body: 'Please re-authenticate',
      targets: [
        { email: EMAIL, deviceId: 'd1' },
        { email: EMAIL, deviceId: 'd2' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.successful).toBe(0);
    expect(res.body.failed).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Route-level 400 codes (specific validators after zod) — Req 15.3
// ---------------------------------------------------------------------------

describe('route-level validation codes', () => {
  it('ban -> 400 invalid_reason for a whitespace-only reason (no service call)', async () => {
    const res = await post('/admin/tenants/devices/ban', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: '   ',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_reason' });
    expect(asMock(svc.ban)).not.toHaveBeenCalled();
  });

  it('ban -> 400 invalid_expiration for an expiration not later than now (no service call)', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const res = await post('/admin/tenants/devices/ban', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
      expiresAt: past,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_expiration' });
    expect(asMock(svc.ban)).not.toHaveBeenCalled();
  });

  it('delete -> 400 invalid_reason for an empty reason (no service call)', async () => {
    const res = await post('/admin/tenants/devices/delete', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: '',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_reason' });
    expect(asMock(svc.softDelete)).not.toHaveBeenCalled();
  });

  it('permanent-delete -> 400 invalid_reason for a whitespace-only reason (no service call)', async () => {
    const res = await post('/admin/tenants/devices/permanent-delete', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: '\t\n ',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_reason' });
    expect(asMock(svc.permanentDelete)).not.toHaveBeenCalled();
  });

  it('notify -> 400 invalid_title for a blank title (no service call)', async () => {
    const res = await post('/admin/tenants/devices/notify', {
      tenantId: TENANT,
      title: '   ',
      body: 'Please re-authenticate',
      targets: [{ email: EMAIL, deviceId: DEVICE }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_title' });
    expect(asMock(svc.notify)).not.toHaveBeenCalled();
  });

  it('notify -> 400 invalid_message for a blank body (no service call)', async () => {
    const res = await post('/admin/tenants/devices/notify', {
      tenantId: TENANT,
      title: 'Heads up',
      body: '   ',
      targets: [{ email: EMAIL, deviceId: DEVICE }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_message' });
    expect(asMock(svc.notify)).not.toHaveBeenCalled();
  });

  it('notify -> 400 empty_recipients for an empty target list (no service call)', async () => {
    const res = await post('/admin/tenants/devices/notify', {
      tenantId: TENANT,
      title: 'Heads up',
      body: 'Please re-authenticate',
      targets: [],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'empty_recipients' });
    expect(asMock(svc.notify)).not.toHaveBeenCalled();
  });

  it('notify -> 400 too_many_targets for more than 500 recipients (no service call)', async () => {
    const targets = Array.from({ length: 501 }, (_, i) => ({
      email: `user${i}@example.com`,
      deviceId: `d-${i}`,
    }));
    const res = await post('/admin/tenants/devices/notify', {
      tenantId: TENANT,
      title: 'Heads up',
      body: 'Please re-authenticate',
      targets,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'too_many_targets' });
    expect(asMock(svc.notify)).not.toHaveBeenCalled();
  });

  it('bulk force-logout -> 400 too_many_targets for more than 500 targets (no service call)', async () => {
    const targets = Array.from({ length: 501 }, (_, i) => ({
      email: `user${i}@example.com`,
      deviceId: `d-${i}`,
    }));
    const res = await post('/admin/tenants/devices/bulk/force-logout', {
      tenantId: TENANT,
      targets,
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'too_many_targets' });
    expect(asMock(svc.bulkForceLogout)).not.toHaveBeenCalled();
  });

  it('bulk force-logout -> 400 validation_failed for an empty target list (no service call)', async () => {
    const res = await post('/admin/tenants/devices/bulk/force-logout', {
      tenantId: TENANT,
      targets: [],
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'validation_failed' });
    expect(asMock(svc.bulkForceLogout)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Service error -> HTTP mapping (design Error Handling table)
// ---------------------------------------------------------------------------

describe('service error mapping', () => {
  // 403 tenant_scope_violation ---------------------------------------------
  it('detail -> 403 tenant_scope_violation (TenantScopeError)', async () => {
    asMock(svc.fetchDeviceDetail).mockRejectedValue(new TenantScopeError());
    const res = await post('/admin/tenants/devices/detail', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'tenant_scope_violation' });
  });

  it('force-logout -> 403 tenant_scope_violation (TenantScopeError)', async () => {
    asMock(svc.forceLogout).mockRejectedValue(new TenantScopeError());
    const res = await post('/admin/tenants/devices/force-logout', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'tenant_scope_violation' });
  });

  it('bulk force-logout -> 403 tenant_scope_violation (TenantScopeError)', async () => {
    asMock(svc.bulkForceLogout).mockRejectedValue(new TenantScopeError());
    const res = await post('/admin/tenants/devices/bulk/force-logout', {
      tenantId: TENANT,
      targets: [{ email: EMAIL, deviceId: DEVICE }],
    });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'tenant_scope_violation' });
  });

  // 404 device_not_found ----------------------------------------------------
  it('detail -> 404 device_not_found (DeviceNotFoundError)', async () => {
    asMock(svc.fetchDeviceDetail).mockRejectedValue(new DeviceNotFoundError());
    const res = await post('/admin/tenants/devices/detail', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'device_not_found' });
  });

  it('force-logout -> 404 device_not_found (DeviceNotFoundError)', async () => {
    asMock(svc.forceLogout).mockRejectedValue(new DeviceNotFoundError());
    const res = await post('/admin/tenants/devices/force-logout', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'device_not_found' });
  });

  it('permanent-delete -> 404 device_not_found (DeviceNotFoundError)', async () => {
    asMock(svc.permanentDelete).mockRejectedValue(new DeviceNotFoundError());
    const res = await post('/admin/tenants/devices/permanent-delete', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'device_not_found' });
  });

  // 409 conflicts -----------------------------------------------------------
  it('force-logout -> 409 already_deleted (DeviceConflictError)', async () => {
    asMock(svc.forceLogout).mockRejectedValue(new DeviceConflictError('already_deleted'));
    const res = await post('/admin/tenants/devices/force-logout', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'already_deleted' });
  });

  it('delete -> 409 already_deleted (DeviceConflictError)', async () => {
    asMock(svc.softDelete).mockRejectedValue(new DeviceConflictError('already_deleted'));
    const res = await post('/admin/tenants/devices/delete', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'already_deleted' });
  });

  it('restore -> 409 not_deleted (DeviceConflictError)', async () => {
    asMock(svc.restore).mockRejectedValue(new DeviceConflictError('not_deleted', 'Device is not deleted'));
    const res = await post('/admin/tenants/devices/restore', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'not_deleted' });
  });

  it('ban -> 409 active_ban_exists (DeviceConflictError)', async () => {
    asMock(svc.ban).mockRejectedValue(new DeviceConflictError('active_ban_exists'));
    const res = await post('/admin/tenants/devices/ban', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'active_ban_exists' });
  });

  it('unban -> 409 no_active_ban (DeviceConflictError)', async () => {
    asMock(svc.unban).mockRejectedValue(new DeviceConflictError('no_active_ban', 'No active ban'));
    const res = await post('/admin/tenants/devices/unban', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'no_active_ban' });
  });

  // 500 variants ------------------------------------------------------------
  it('force-logout -> 500 signal_write_failed (SignalWriteError)', async () => {
    asMock(svc.forceLogout).mockRejectedValue(new SignalWriteError());
    const res = await post('/admin/tenants/devices/force-logout', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'signal_write_failed' });
  });

  it('permanent-delete -> 500 delete_rolled_back (DeleteRolledBackError)', async () => {
    asMock(svc.permanentDelete).mockRejectedValue(new DeleteRolledBackError());
    const res = await post('/admin/tenants/devices/permanent-delete', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'delete_rolled_back' });
  });

  it('force-logout-all -> 500 signal_write_failed with affected + failedDeviceIds (ForceLogoutAllError)', async () => {
    asMock(svc.forceLogoutAll).mockRejectedValue(new ForceLogoutAllError(2, ['d-3', 'd-4']));
    const res = await post('/admin/tenants/devices/force-logout-all', {
      tenantId: TENANT,
      email: EMAIL,
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('signal_write_failed');
    expect(res.body.affected).toBe(2);
    expect(res.body.failedDeviceIds).toEqual(['d-3', 'd-4']);
  });

  it('history -> 500 history_failed and returns no partial entries', async () => {
    asMock(svc.fetchHistory).mockRejectedValue(new Error('firestore unavailable'));
    const res = await post('/admin/tenants/devices/history', { tenantId: TENANT });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'history_failed' });
    expect(res.body).not.toHaveProperty('entries');
  });

  it('list -> 500 device_list_failed on load failure', async () => {
    asMock(svc.listTenantDevices).mockRejectedValue(new Error('firestore unavailable'));
    const res = await post('/admin/tenants/devices', { tenantId: TENANT });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'device_list_failed' });
  });

  it('timeline -> 500 timeline_failed on load failure', async () => {
    asMock(svc.fetchTimeline).mockRejectedValue(new Error('firestore unavailable'));
    const res = await post('/admin/tenants/devices/timeline', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'timeline_failed' });
  });

  // Audit-write failure path (durable-audit persistence failed).
  //
  // The design's Error Handling table lists a dedicated `audit_write_failed`
  // (500) code so callers/operators can tell "the action ran but its durable
  // audit entry was not recorded" apart from any other failure. `writeAudit`
  // now rejects with a typed `AuditWriteError` (a `DeviceAdminError` carrying
  // `code: 'audit_write_failed'`, `status: 500`), which the routes' generic
  // `instanceof DeviceAdminError` mapping surfaces as `audit_write_failed` on
  // whichever endpoint drove the (already-committed) action.
  it('force-logout -> 500 audit_write_failed when the audit write fails (AuditWriteError)', async () => {
    asMock(svc.forceLogout).mockRejectedValue(new AuditWriteError());
    const res = await post('/admin/tenants/devices/force-logout', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'audit_write_failed' });
  });

  it('ban -> 500 audit_write_failed when the audit write fails (AuditWriteError)', async () => {
    asMock(svc.ban).mockRejectedValue(new AuditWriteError());
    const res = await post('/admin/tenants/devices/ban', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'audit_write_failed' });
  });

  it('delete -> 500 audit_write_failed when the audit write fails (AuditWriteError)', async () => {
    asMock(svc.softDelete).mockRejectedValue(new AuditWriteError());
    const res = await post('/admin/tenants/devices/delete', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      reason: REASON,
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'audit_write_failed' });
  });

  // A genuinely untyped/unexpected orchestrator rejection (not a
  // `DeviceAdminError`) must still fall back to the endpoint's own generic 500
  // code — the typed `audit_write_failed` mapping above must not swallow these.
  it('force-logout -> 500 generic fallback for an unexpected (untyped) orchestrator error', async () => {
    asMock(svc.forceLogout).mockRejectedValue(new Error('kaboom'));
    const res = await post('/admin/tenants/devices/force-logout', {
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'force_logout_failed' });
  });
});
