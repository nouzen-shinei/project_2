/**
 * Route tests for `POST /tenants/:tenantId/members/force-logout`.
 *
 * This is the app-client-reachable, tenant-admin-authorized counterpart to the
 * master-gated `/admin/tenants/devices/force-logout-all` Device Console route.
 * It authorizes through the shared tenant-access guard (`minRole: 'admin'`,
 * owner/admin only) rather than the master/global-admin gate, and reuses the
 * `deviceAdminService.forceLogoutAll` orchestrator.
 *
 * Strategy (fast unit tests, no emulator), mirroring `deviceAdminRoutes.test.ts`
 * but adapted to the tenant-access middleware:
 *   - The service orchestrator (`forceLogoutAll`) is mocked; the real typed
 *     error classes are preserved via `requireActual` so the route's
 *     `instanceof ForceLogoutAllError` / `instanceof DeviceAdminError` mapping
 *     works unchanged.
 *   - `getMaintenanceMode` is stubbed so the non-`/admin/` path doesn't touch
 *     Firestore in the maintenance middleware.
 *   - Auth uses an HMAC-signed INTERNAL token (the per-user token the app client
 *     actually presents — NOT a master token), so `authContext.tokenType` is
 *     `'internal'` and the master gate is irrelevant.
 *   - `createApp`'s `requireTenantMembershipAccess` override drives the resolved
 *     tenant role per test: owner/admin grant access; staff/member yield an
 *     insufficient-role 403; a non-member throws membership-required 403 —
 *     exercising the `minRole: 'admin'` gate.
 */

import crypto from 'crypto';
import type { Server } from 'http';

// Must be set before `createApp` (and the auth middleware) read them.
process.env.TEST_MODE = '1';
process.env.INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || 'members-force-logout-secret';

// The `/tenants/...` path is NOT in the maintenance-bypass list, so the
// maintenance middleware would otherwise call Firestore. Stub it to null.
jest.mock('../maintenanceMode', () => ({
  __esModule: true,
  getMaintenanceMode: jest.fn(async () => null),
}));

// Stub the orchestrator; keep the real pure helpers + typed error classes.
jest.mock('../deviceAdminService', () => {
  const actual = jest.requireActual('../deviceAdminService');
  return {
    __esModule: true,
    ...actual,
    forceLogoutAll: jest.fn(),
  };
});

import { createApp, TenantAccessError } from '../app';
import * as svc from '../deviceAdminService';
import { ForceLogoutAllError } from '../deviceAdminService';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

const SECRET = process.env.INTERNAL_API_KEY as string;
const TENANT = 'tenant-xyz-123';
const MEMBER = 'member@example.com';

type TestRole = 'owner' | 'admin' | 'staff' | 'member' | 'none';
const ROLE_PRIORITY: Record<Exclude<TestRole, 'none'>, number> = {
  member: 1,
  staff: 2,
  admin: 3,
  owner: 4,
};

/** The tenant role the guard override resolves for the next request. */
let currentRole: TestRole = 'owner';

/** Sign an internal token (HMAC over a base64url JSON payload). */
function signToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** The per-user internal token the app client presents (NOT a master token). */
function appUserToken(): string {
  return signToken({
    sub: 'user-1',
    email: 'caller@example.com',
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

const asMock = (fn: unknown): jest.Mock => fn as unknown as jest.Mock;

let server: Server;
let base: string;

async function post(
  path: string,
  body: unknown,
  token: string | null = appUserToken()
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

const FORCE_LOGOUT_PATH = `/tenants/${TENANT}/members/force-logout`;

beforeAll(async () => {
  const app = createApp({
    overrides: {
      // Drive the resolved tenant role per test. Faithfully replicates the real
      // `requireTenantMembershipAccess`: it enforces `minRole` (throwing a 403
      // TenantAccessError below it) and models a non-member as a
      // membership-required 403.
      requireTenantMembershipAccess: async (
        _ctx: any,
        tenantId: string,
        opts: { minRole?: 'owner' | 'admin' | 'staff' | 'member' } = {}
      ) => {
        if (currentRole === 'none') {
          throw new TenantAccessError(403, { error: 'tenant_membership_required' });
        }
        const minRole = opts.minRole ?? 'staff';
        if ((ROLE_PRIORITY[currentRole] ?? 0) < (ROLE_PRIORITY[minRole] ?? 0)) {
          throw new TenantAccessError(403, {
            error: 'tenant_role_insufficient',
            requiredRole: minRole,
            currentRole,
          });
        }
        return { tenantId, role: currentRole, membershipId: null };
      },
      // The guard reads a Firestore handle before its (internal-token) billing
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
  currentRole = 'owner';
});

// ---------------------------------------------------------------------------
// Authorized callers (owner + admin) -> 200 and orchestrator invoked
// ---------------------------------------------------------------------------

describe('authorized (owner/admin) callers', () => {
  it.each(['owner', 'admin'] as const)(
    '%s -> 200 { ok, affected } and forceLogoutAll called with tenant/email/actor',
    async (role) => {
      currentRole = role;
      asMock(svc.forceLogoutAll).mockResolvedValue({ ok: true, affected: 3 });

      const res = await post(FORCE_LOGOUT_PATH, { email: MEMBER });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, affected: 3 });
      expect(asMock(svc.forceLogoutAll)).toHaveBeenCalledTimes(1);
      expect(asMock(svc.forceLogoutAll)).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          email: MEMBER,
          actor: expect.objectContaining({ id: 'user-1', email: 'caller@example.com' }),
        })
      );
    }
  );

  it('normalizes the target email before delegating', async () => {
    asMock(svc.forceLogoutAll).mockResolvedValue({ ok: true, affected: 0 });

    const res = await post(FORCE_LOGOUT_PATH, { email: '  Member@Example.com  ' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, affected: 0 });
    expect(asMock(svc.forceLogoutAll)).toHaveBeenCalledWith(
      expect.objectContaining({ email: MEMBER })
    );
  });
});

// ---------------------------------------------------------------------------
// The minRole:'admin' gate -> 403 for insufficient/absent tenant access
// ---------------------------------------------------------------------------

describe('minRole:admin authorization gate', () => {
  it.each(['staff', 'member'] as const)(
    '%s -> 403 (insufficient role) and no orchestration',
    async (role) => {
      currentRole = role;

      const res = await post(FORCE_LOGOUT_PATH, { email: MEMBER });

      expect(res.status).toBe(403);
      expect(asMock(svc.forceLogoutAll)).not.toHaveBeenCalled();
    }
  );

  it('non-member -> 403 (membership required) and no orchestration', async () => {
    currentRole = 'none';

    const res = await post(FORCE_LOGOUT_PATH, { email: MEMBER });

    expect(res.status).toBe(403);
    expect(asMock(svc.forceLogoutAll)).not.toHaveBeenCalled();
  });

  it('no bearer token -> 401 (auth middleware pre-empts) and no orchestration', async () => {
    const res = await post(FORCE_LOGOUT_PATH, { email: MEMBER }, null);

    expect(res.status).toBe(401);
    expect(asMock(svc.forceLogoutAll)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Body validation -> 400 validation_failed (no orchestration)
// ---------------------------------------------------------------------------

describe('request validation', () => {
  it('missing email -> 400 validation_failed', async () => {
    const res = await post(FORCE_LOGOUT_PATH, {});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(asMock(svc.forceLogoutAll)).not.toHaveBeenCalled();
  });

  it('malformed email -> 400 validation_failed', async () => {
    const res = await post(FORCE_LOGOUT_PATH, { email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('validation_failed');
    expect(asMock(svc.forceLogoutAll)).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Service error -> HTTP mapping
// ---------------------------------------------------------------------------

describe('service error mapping', () => {
  it('ForceLogoutAllError -> 500 signal_write_failed with affected + failedDeviceIds', async () => {
    asMock(svc.forceLogoutAll).mockRejectedValue(
      new ForceLogoutAllError(2, ['device-3', 'device-4'])
    );

    const res = await post(FORCE_LOGOUT_PATH, { email: MEMBER });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: 'signal_write_failed',
      affected: 2,
      failedDeviceIds: ['device-3', 'device-4'],
    });
  });

  it('unexpected error -> 500 force_logout_all_failed', async () => {
    asMock(svc.forceLogoutAll).mockRejectedValue(new Error('boom'));

    const res = await post(FORCE_LOGOUT_PATH, { email: MEMBER });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'force_logout_all_failed' });
  });
});
