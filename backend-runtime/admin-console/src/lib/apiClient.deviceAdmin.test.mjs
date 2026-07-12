// Feature: device-console-migration, Task 12.2 — unit tests for the device-admin
// client wrappers in `apiClient.ts`.
//
// These tests exercise the REAL exported wrappers (no re-implementation): they
// drive each function through the shared `apiRequest` helper with a mocked
// `fetch` transport so nothing hits the network, and assert the request shaping
// (URL/path, POST method, JSON body, master `Authorization` header) plus the
// `ApiError` mapping (status + parsed data) that callers branch on for backend
// error codes such as `device_not_found` and `active_ban_exists`.
//
// The admin console has no configured test runner, so this mirrors the sibling
// `backend-runtime/tests/*.test.mjs` convention: Node's built-in `node --test`
// runner + `node:assert`. The module graph (TS + the `@shared/planLimits`
// alias + zustand) is bundled with the repo's already-present esbuild before
// running — see the command reported alongside this task.

import test from 'node:test';
import assert from 'node:assert/strict';

// The console store persists via zustand's `persist` middleware, which reaches
// for browser `localStorage`. Under Node there is none, so we install a tiny
// in-memory shim BEFORE the store module is evaluated (hence the dynamic
// imports below) to keep initialization quiet and deterministic.
if (!globalThis.localStorage) {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => {
      mem.set(k, String(v));
    },
    removeItem: (k) => {
      mem.delete(k);
    },
    clear: () => {
      mem.clear();
    },
    key: (i) => Array.from(mem.keys())[i] ?? null,
    get length() {
      return mem.size;
    },
  };
}

const {
  ApiError,
  fetchTenantDevices,
  fetchDeviceDetail,
  forceLogoutDevice,
  banDevice,
  bulkForceLogoutDevices,
  notifyDevices,
  fetchDeviceHistory,
} = await import('./apiClient');
const { useConfigStore } = await import('../store/configStore');

const BASE_URL = 'https://api.example.test';
const MASTER_KEY = 'master-secret-abc123';

// Configure the console store so `resolveBaseUrl()` returns a concrete origin
// and `resolveAuthHeader('master')` produces the master bearer token.
useConfigStore.getState().setBaseUrl(BASE_URL);
useConfigStore.getState().setMasterKey(MASTER_KEY);

// --- fetch transport mock --------------------------------------------------

/** @type {{ url: string, method?: string, body?: unknown, auth?: string | null, contentType?: string | null } | null} */
let lastRequest = null;

function makeResponse(status, dataObj) {
  const bodyText = JSON.stringify(dataObj);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return bodyText;
    },
    async blob() {
      return {
        async text() {
          return bodyText;
        },
      };
    },
  };
}

function installFetch(status, dataObj) {
  lastRequest = null;
  globalThis.fetch = async (url, init) => {
    const headers = init && init.headers;
    lastRequest = {
      url: String(url),
      method: init && init.method,
      body: init && init.body,
      auth: headers && typeof headers.get === 'function' ? headers.get('Authorization') : undefined,
      contentType: headers && typeof headers.get === 'function' ? headers.get('Content-Type') : undefined,
    };
    return makeResponse(status, dataObj);
  };
}

function sentBody() {
  assert.ok(lastRequest, 'fetch was not invoked');
  return typeof lastRequest.body === 'string' ? JSON.parse(lastRequest.body) : lastRequest.body;
}

// --- request shaping -------------------------------------------------------

test('fetchTenantDevices POSTs the full filter body to /admin/tenants/devices with master auth', async () => {
  const payload = { tenantId: 't-1', search: '10.0.0.1', filter: 'online', sort: 'lastSeen', hideInactive: true };
  const response = { ok: true, tenantId: 't-1', counts: { total: 3, online: 1, offline: 2 }, devices: [] };
  installFetch(200, response);

  const result = await fetchTenantDevices(payload);

  assert.equal(lastRequest.url, `${BASE_URL}/admin/tenants/devices`);
  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.auth, `Bearer ${MASTER_KEY}`);
  assert.equal(lastRequest.contentType, 'application/json');
  assert.deepEqual(sentBody(), payload);
  assert.deepEqual(result, response);
});

test('forceLogoutDevice POSTs {tenantId,email,deviceId,reason} to the force-logout endpoint', async () => {
  const payload = { tenantId: 't-1', email: 'user@example.com', deviceId: 'dev-9', reason: 'compromised' };
  installFetch(200, { ok: true });

  const result = await forceLogoutDevice(payload);

  assert.equal(lastRequest.url, `${BASE_URL}/admin/tenants/devices/force-logout`);
  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.auth, `Bearer ${MASTER_KEY}`);
  assert.deepEqual(sentBody(), payload);
  assert.deepEqual(result, { ok: true });
});

test('banDevice POSTs reason + expiresAt and returns the banId', async () => {
  const payload = {
    tenantId: 't-1',
    email: 'user@example.com',
    deviceId: 'dev-9',
    reason: 'abuse',
    expiresAt: '2030-01-01T00:00:00.000Z',
  };
  installFetch(200, { ok: true, banId: 'ban-42' });

  const result = await banDevice(payload);

  assert.equal(lastRequest.url, `${BASE_URL}/admin/tenants/devices/ban`);
  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.auth, `Bearer ${MASTER_KEY}`);
  assert.deepEqual(sentBody(), payload);
  assert.equal(result.banId, 'ban-42');
});

test('bulkForceLogoutDevices POSTs the targets array to the bulk endpoint', async () => {
  const targets = [
    { email: 'a@example.com', deviceId: 'd1' },
    { email: 'b@example.com', deviceId: 'd2' },
  ];
  const payload = { tenantId: 't-1', targets, reason: 'cleanup' };
  installFetch(200, { ok: true, succeeded: 2, failed: 0, results: [] });

  const result = await bulkForceLogoutDevices(payload);

  assert.equal(lastRequest.url, `${BASE_URL}/admin/tenants/devices/bulk/force-logout`);
  assert.equal(lastRequest.method, 'POST');
  assert.deepEqual(sentBody().targets, targets);
  assert.equal(result.succeeded, 2);
});

test('notifyDevices POSTs title/body/targets/priority to the notify endpoint', async () => {
  const payload = {
    tenantId: 't-1',
    title: 'Heads up',
    body: 'Please re-login',
    targets: [{ email: 'a@example.com', deviceId: 'd1' }],
    priority: 'high',
  };
  installFetch(200, { ok: true, successful: 1, failed: 0, results: [] });

  const result = await notifyDevices(payload);

  assert.equal(lastRequest.url, `${BASE_URL}/admin/tenants/devices/notify`);
  assert.equal(lastRequest.method, 'POST');
  assert.equal(lastRequest.auth, `Bearer ${MASTER_KEY}`);
  assert.deepEqual(sentBody(), payload);
  assert.equal(result.successful, 1);
});

test('fetchDeviceHistory POSTs cursor/limit/action for tenant-scoped history', async () => {
  const payload = { tenantId: 't-1', limit: 25, cursor: 'cursor-abc', action: 'ban' };
  installFetch(200, { ok: true, entries: [], hasMore: true, nextCursor: 'cursor-next' });

  const result = await fetchDeviceHistory(payload);

  assert.equal(lastRequest.url, `${BASE_URL}/admin/tenants/devices/history`);
  assert.equal(lastRequest.method, 'POST');
  assert.deepEqual(sentBody(), payload);
  assert.equal(result.nextCursor, 'cursor-next');
});

// --- ApiError mapping ------------------------------------------------------

test('a non-2xx response surfaces as ApiError carrying status + data (device_not_found)', async () => {
  const errorData = { error: 'device_not_found', message: 'no such device' };
  installFetch(404, errorData);

  await assert.rejects(
    () => fetchDeviceDetail({ tenantId: 't-1', email: 'user@example.com', deviceId: 'missing' }),
    (err) => {
      assert.ok(err instanceof ApiError, 'expected an ApiError instance');
      assert.equal(err.name, 'ApiError');
      assert.equal(err.status, 404);
      assert.deepEqual(err.data, errorData);
      return true;
    },
  );
});

test('a ban conflict surfaces as ApiError with status 409 and the backend error code', async () => {
  const errorData = { error: 'active_ban_exists' };
  installFetch(409, errorData);

  await assert.rejects(
    () => banDevice({ tenantId: 't-1', email: 'user@example.com', deviceId: 'd1', reason: 'abuse' }),
    (err) => {
      assert.ok(err instanceof ApiError, 'expected an ApiError instance');
      assert.equal(err.status, 409);
      assert.deepEqual(err.data, errorData);
      return true;
    },
  );
});
