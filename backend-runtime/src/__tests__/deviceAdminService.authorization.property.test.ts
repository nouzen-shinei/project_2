// Feature: device-console-migration, Property 16: Authorization is enforced on every endpoint

/**
 * Property 16: Authorization is enforced on every endpoint
 * Validates: Requirements 7.7, 10.5, 16.1, 16.2
 *
 * For EVERY one of the 13 Device Admin API endpoints:
 *
 *   - UNAUTHORIZED: a request that presents neither a valid master token nor
 *     valid Global_Admin authorization — credentials absent, malformed,
 *     unrecognized/expired (401), or present-but-not-privileged (403
 *     `not_authorized`) — is rejected with a 401/403 status and performs NO
 *     device-listing or device-action operation (Req 16.2, 7.7, 10.5). "No
 *     operation" is proven by asserting that not a single one of the service
 *     orchestrators (the functions that read or mutate device / ban / signal /
 *     audit state) is ever invoked.
 *
 *   - AUTHORIZED: a request that presents a valid master token OR a valid
 *     Global_Admin claim passes the endpoint's authorization gate (Req 16.1)
 *     and reaches the corresponding service orchestrator, returning a 200
 *     success rather than a `not_authorized` rejection.
 *
 * The property is universally quantified over (endpoint x principal): every
 * endpoint is enumerated so the guarantee is proven for the whole surface, and
 * every principal class (no header, malformed scheme, unrecognized token,
 * authenticated-but-not-admin, master token, Global_Admin claim) is exercised.
 *
 * The Express app is built with `createApp(...)` exactly as production does.
 * The tenant-membership guard is overridden to ALWAYS grant access so that the
 * endpoint's OWN master/global-admin gate is the sole authorization decision
 * under test. The service orchestrators are replaced with call-recording stubs
 * (the pure validators/helpers are kept real) so authorized requests never
 * touch Firestore and "no state change" for unauthorized requests is directly
 * observable as "orchestrator never called".
 */

// Run createApp() in test mode (no schedulers / event-loop monitor), matching
// the route-surface smoke test.
process.env.TEST_MODE = '1';

import * as fc from 'fast-check';
import crypto from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// Replace the I/O orchestrators of deviceAdminService with call-recording
// stubs while keeping every pure helper (validators, classify/count/filter/sort,
// error classes, constants) real — the routes depend on those to get past
// body/field validation on the authorized path.
jest.mock('../deviceAdminService', () => {
  const actual = jest.requireActual('../deviceAdminService');
  return {
    __esModule: true,
    ...actual,
    // Reads
    listTenantDevices: jest.fn(),
    fetchDeviceDetail: jest.fn(),
    fetchHistory: jest.fn(),
    fetchTimeline: jest.fn(),
    // Mutations
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
import * as deviceAdminService from '../deviceAdminService';

const svc = deviceAdminService as unknown as {
  listTenantDevices: jest.Mock;
  fetchDeviceDetail: jest.Mock;
  fetchHistory: jest.Mock;
  fetchTimeline: jest.Mock;
  forceLogout: jest.Mock;
  forceLogoutAll: jest.Mock;
  bulkForceLogout: jest.Mock;
  ban: jest.Mock;
  unban: jest.Mock;
  softDelete: jest.Mock;
  restore: jest.Mock;
  permanentDelete: jest.Mock;
  notify: jest.Mock;
};

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_MASTER_SECRET = 'device-authz-property-master-secret';
const FIREBASE_ADMIN_TOKEN = 'firebase-token-global-admin';
const FIREBASE_NONADMIN_TOKEN = 'firebase-token-plain-user';
const FIREBASE_INVALID_TOKEN = 'firebase-token-unrecognized';

/** Every orchestrator that reads or mutates device / ban / signal / audit state. */
const ALL_ORCHESTRATORS = (): jest.Mock[] => [
  svc.listTenantDevices,
  svc.fetchDeviceDetail,
  svc.fetchHistory,
  svc.fetchTimeline,
  svc.forceLogout,
  svc.forceLogoutAll,
  svc.bulkForceLogout,
  svc.ban,
  svc.unban,
  svc.softDelete,
  svc.restore,
  svc.permanentDelete,
  svc.notify,
];

/** The 13 Device Admin API endpoints, each with a valid body + its orchestrator. */
interface EndpointCase {
  readonly name: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
  readonly spy: () => jest.Mock;
}

const ENDPOINTS: ReadonlyArray<EndpointCase> = [
  { name: '#1 list', path: '/admin/tenants/devices', body: { tenantId: 't1' }, spy: () => svc.listTenantDevices },
  {
    name: '#2 detail',
    path: '/admin/tenants/devices/detail',
    body: { tenantId: 't1', email: 'user@example.com', deviceId: 'd1' },
    spy: () => svc.fetchDeviceDetail,
  },
  { name: '#12 history', path: '/admin/tenants/devices/history', body: { tenantId: 't1' }, spy: () => svc.fetchHistory },
  {
    name: '#13 timeline',
    path: '/admin/tenants/devices/timeline',
    body: { tenantId: 't1', email: 'user@example.com', deviceId: 'd1' },
    spy: () => svc.fetchTimeline,
  },
  {
    name: '#3 force-logout',
    path: '/admin/tenants/devices/force-logout',
    body: { tenantId: 't1', email: 'user@example.com', deviceId: 'd1', reason: 'ending stray session' },
    spy: () => svc.forceLogout,
  },
  {
    name: '#6 ban',
    path: '/admin/tenants/devices/ban',
    body: { tenantId: 't1', email: 'user@example.com', deviceId: 'd1', reason: 'abuse from this fingerprint' },
    spy: () => svc.ban,
  },
  {
    name: '#7 unban',
    path: '/admin/tenants/devices/unban',
    body: { tenantId: 't1', email: 'user@example.com', deviceId: 'd1' },
    spy: () => svc.unban,
  },
  {
    name: '#8 delete',
    path: '/admin/tenants/devices/delete',
    body: { tenantId: 't1', email: 'user@example.com', deviceId: 'd1', reason: 'decommissioning device' },
    spy: () => svc.softDelete,
  },
  {
    name: '#9 restore',
    path: '/admin/tenants/devices/restore',
    body: { tenantId: 't1', email: 'user@example.com', deviceId: 'd1' },
    spy: () => svc.restore,
  },
  {
    name: '#10 permanent-delete',
    path: '/admin/tenants/devices/permanent-delete',
    body: { tenantId: 't1', email: 'user@example.com', deviceId: 'd1', reason: 'gdpr erasure request' },
    spy: () => svc.permanentDelete,
  },
  {
    name: '#4 force-logout-all',
    path: '/admin/tenants/devices/force-logout-all',
    body: { tenantId: 't1', email: 'user@example.com' },
    spy: () => svc.forceLogoutAll,
  },
  {
    name: '#5 bulk force-logout',
    path: '/admin/tenants/devices/bulk/force-logout',
    body: { tenantId: 't1', targets: [{ email: 'user@example.com', deviceId: 'd1' }] },
    spy: () => svc.bulkForceLogout,
  },
  {
    name: '#11 notify',
    path: '/admin/tenants/devices/notify',
    body: { tenantId: 't1', title: 'Heads up', body: 'Please re-authenticate now', targets: [{ email: 'user@example.com', deviceId: 'd1' }] },
    spy: () => svc.notify,
  },
];

/** Signs an internal token the same way the app's auth middleware verifies it. */
function signInternalToken(payloadData: Record<string, unknown>): string {
  const secret = process.env.INTERNAL_API_KEY as string;
  const payload = Buffer.from(JSON.stringify(payloadData)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function nowPlus(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

/** Builds the Authorization header (if any) for a principal at request time. */
type Principal = { readonly label: string; readonly header: () => Record<string, string> };

const UNAUTHORIZED_PRINCIPALS: ReadonlyArray<Principal & { readonly expectStatus: number }> = [
  // Credentials absent → 401 before the route runs.
  { label: 'no-authorization-header', expectStatus: 401, header: () => ({}) },
  // Malformed scheme (not Bearer) → 401.
  { label: 'malformed-scheme', expectStatus: 401, header: () => ({ Authorization: 'Basic dXNlcjpwYXNz' }) },
  // Unrecognized bearer token (fails firebase verification) → 401.
  { label: 'unrecognized-token', expectStatus: 401, header: () => ({ Authorization: `Bearer ${FIREBASE_INVALID_TOKEN}` }) },
  // Authenticated but NOT a Global_Admin (firebase, admin claim false) → 403 not_authorized.
  { label: 'authenticated-non-admin-firebase', expectStatus: 403, header: () => ({ Authorization: `Bearer ${FIREBASE_NONADMIN_TOKEN}` }) },
  // Valid internal token that is NOT a master token → 403 not_authorized.
  {
    label: 'internal-non-master-token',
    expectStatus: 403,
    header: () => ({ Authorization: `Bearer ${signInternalToken({ sub: 'staff', email: 'staff@example.com', exp: nowPlus(300) })}` }),
  },
];

const AUTHORIZED_PRINCIPALS: ReadonlyArray<Principal> = [
  // Master token, presented as a signed internal token carrying master:true and
  // an email (so actor-email resolution stays offline).
  {
    label: 'master-token',
    header: () => ({ Authorization: `Bearer ${signInternalToken({ sub: 'op', email: 'op@example.com', master: true, exp: nowPlus(300) })}` }),
  },
  // Global_Admin via a firebase token carrying the admin claim.
  { label: 'global-admin-firebase', header: () => ({ Authorization: `Bearer ${FIREBASE_ADMIN_TOKEN}` }) },
];

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let server: Server;
let baseUrl: string;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string): void {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

beforeAll(async () => {
  setEnv('INTERNAL_API_KEY', TEST_MASTER_SECRET);
  // Keep the tenant-access billing check inert so the guard never touches Firestore.
  setEnv('BILLING_DELINQUENCY_ENFORCEMENT_ENABLED', '0');

  const app = createApp({
    overrides: {
      // Grant tenant access to EVERY caller so the only authorization decision
      // exercised is each endpoint's own master/global-admin gate.
      requireTenantMembershipAccess: async (_authContext: unknown, tenantIdRaw: unknown) => ({
        tenantId: typeof tenantIdRaw === 'string' && tenantIdRaw.trim() ? tenantIdRaw.trim() : 'tenant',
        role: 'owner',
        membershipId: 'membership-1',
      }),
      // Deterministic firebase verification: only the admin token yields a
      // Global_Admin claim; the non-admin token authenticates without it; every
      // other token is unrecognized.
      verifyFirebaseIdToken: async (token: string) => {
        if (token === FIREBASE_ADMIN_TOKEN) {
          return { uid: 'admin-uid', email: 'admin@example.com', admin: true };
        }
        if (token === FIREBASE_NONADMIN_TOKEN) {
          return { uid: 'user-uid', email: 'user@example.com', admin: false };
        }
        throw new Error('unrecognized firebase id token');
      },
    },
  });

  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

beforeEach(() => {
  // Fresh call counts each test; default (persistent) implementations below.
  for (const spy of ALL_ORCHESTRATORS()) {
    spy.mockReset();
  }
  svc.listTenantDevices.mockResolvedValue([]);
  svc.fetchDeviceDetail.mockResolvedValue({ deviceId: 'd1' });
  svc.fetchHistory.mockResolvedValue({ entries: [], hasMore: false });
  svc.fetchTimeline.mockResolvedValue({ entries: [] });
  svc.forceLogout.mockResolvedValue({ ok: true });
  svc.forceLogoutAll.mockResolvedValue({ affected: 0 });
  svc.bulkForceLogout.mockResolvedValue({ succeeded: 0, failed: 0, results: [] });
  svc.ban.mockResolvedValue({ ok: true, banId: 'ban-1' });
  svc.unban.mockResolvedValue({ ok: true });
  svc.softDelete.mockResolvedValue({ ok: true });
  svc.restore.mockResolvedValue({ ok: true });
  svc.permanentDelete.mockResolvedValue({ ok: true });
  svc.notify.mockResolvedValue({ successful: 0, failed: 0, results: [] });
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  json: any;
}

async function postJson(path: string, body: unknown, headers: Record<string, string>): Promise<HttpResult> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let json: any;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

function clearOrchestratorCalls(): void {
  for (const spy of ALL_ORCHESTRATORS()) {
    spy.mockClear();
  }
}

function totalOrchestratorCalls(): number {
  return ALL_ORCHESTRATORS().reduce((sum, spy) => sum + spy.mock.calls.length, 0);
}

// ---------------------------------------------------------------------------
// Property 16
// ---------------------------------------------------------------------------

describe('Property 16: Authorization is enforced on every Device Admin API endpoint', () => {
  it('rejects unauthorized requests (401/403) with NO state change, for every endpoint x principal', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ENDPOINTS),
        fc.constantFrom(...UNAUTHORIZED_PRINCIPALS),
        async (endpoint, principal) => {
          clearOrchestratorCalls();

          const res = await postJson(endpoint.path, endpoint.body, principal.header());

          // Rejected with the mapped status (401 for absent/malformed/unrecognized
          // credentials, 403 for authenticated-but-not-privileged) — Req 16.2.
          expect(res.status).toBe(principal.expectStatus);
          if (res.status === 403) {
            expect(res.json?.error).toBe('not_authorized');
          }

          // No device-listing or device-action operation was performed
          // (Req 16.2, 7.7, 10.5): not a single orchestrator was invoked.
          expect(totalOrchestratorCalls()).toBe(0);
        }
      ),
      { numRuns: 300 }
    );
  });

  it('authorizes valid master / Global_Admin requests: gate passes and the endpoint runs, for every endpoint x principal', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ENDPOINTS),
        fc.constantFrom(...AUTHORIZED_PRINCIPALS),
        async (endpoint, principal) => {
          clearOrchestratorCalls();

          const res = await postJson(endpoint.path, endpoint.body, principal.header());

          // Gate passed (Req 16.1): the request was not rejected as unauthorized
          // and reached the endpoint's service orchestrator exactly once.
          expect(res.status).toBe(200);
          expect(res.json?.ok).toBe(true);
          expect(endpoint.spy()).toHaveBeenCalledTimes(1);
        }
      ),
      { numRuns: 300 }
    );
  });
});
