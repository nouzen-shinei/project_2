// Feature: device-console-migration — fetchTimeline existence/scope + pagination (FIX 5A)

/**
 * Unit tests for `fetchTimeline`'s NON-ordering behavior:
 *   - 404 `device_not_found` for an unknown device (existence check).
 *   - 403 `tenant_scope_violation` for a device outside the scoped tenant.
 *   - 200 with an empty `entries` array for an in-scope device with no audit
 *     rows (existence, not audit rows, drives 404).
 *   - Opaque doc-id cursor pagination (ascending): `hasMore` / `nextCursor`
 *     across pages, joining without gaps or overlaps.
 *
 * `fetchTimeline` reads Firestore, so this suite replaces `getFirestore()` with
 * a small in-memory fake that supports the exact call shapes the helper builds:
 *   - `collection('user_devices').doc(email).collection('devices').doc(id).get()`
 *   - `collection('deviceAuditLogs').where(..).where(..).orderBy('actionTimeMs','asc')
 *        [.startAfter(snap)].limit(n).get()`
 *   - `collection('deviceAuditLogs').doc(cursor).get()`  (cursor re-read)
 *
 * Ordering (Property 22) is covered separately by the timeline property suite;
 * here the fake sorts deterministically by `(actionTimeMs asc, id asc)` — which
 * mirrors Firestore's `(actionTimeMs, __name__)` order — so pagination is
 * predictable.
 */

import { getFirestore } from '../firebaseAdmin';
import {
  fetchTimeline,
  DEVICE_AUDIT_LOG_COLLECTION,
  DeviceNotFoundError,
  TenantScopeError,
} from '../deviceAdminService';

jest.mock('../firebaseAdmin');

const mockedGetFirestore = getFirestore as jest.MockedFunction<typeof getFirestore>;

const TENANT = 't1';
const EMAIL = 'owner@example.com';
const DEVICE = 'device-1';

interface StoredDoc {
  id: string;
  data: Record<string, unknown>;
}

interface DocSnapshot {
  id: string;
  exists: boolean;
  data: () => Record<string, unknown> | undefined;
}

interface EqFilter {
  field: string;
  value: unknown;
}

class FakeDocRef {
  constructor(
    private readonly store: FakeFirestore,
    private readonly path: string
  ) {}

  collection(name: string): FakeQuery {
    return new FakeQuery(this.store, `${this.path}/${name}`);
  }

  async get(): Promise<DocSnapshot> {
    const data = this.store.getDoc(this.path);
    const id = this.path.split('/').pop() ?? '';
    return { id, exists: data !== undefined, data: () => (data ? { ...data } : undefined) };
  }
}

class FakeQuery {
  private filters: EqFilter[] = [];
  private orderField: string | null = null;
  private limitN: number | null = null;
  private startAfterSnap: { orderValue: number; id: string } | null = null;

  constructor(
    private readonly store: FakeFirestore,
    private readonly collectionName: string
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    if (op !== '==') {
      throw new Error(`FakeQuery only supports '==' filters, got '${op}'`);
    }
    this.filters.push({ field, value });
    return this;
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): FakeQuery {
    if (direction !== 'asc') {
      throw new Error(`FakeQuery only exercises ascending orderBy, got '${direction}'`);
    }
    this.orderField = field;
    return this;
  }

  limit(n: number): FakeQuery {
    this.limitN = n;
    return this;
  }

  startAfter(snap: DocSnapshot): FakeQuery {
    const data = snap.data() ?? {};
    const orderValue = (data[this.orderField ?? 'actionTimeMs'] as number) ?? 0;
    this.startAfterSnap = { orderValue, id: snap.id };
    return this;
  }

  doc(id: string): FakeDocRef {
    return new FakeDocRef(this.store, `${this.collectionName}/${id}`);
  }

  async get(): Promise<{ docs: Array<{ id: string; data: () => Record<string, unknown> }> }> {
    let matched = this.store
      .collectionDocs(this.collectionName)
      .filter((doc) => this.filters.every((f) => doc.data[f.field] === f.value));

    // Deterministic (actionTimeMs asc, id asc) — mirrors Firestore's implicit
    // (orderField, __name__) ordering with `id` as the document name.
    const field = this.orderField;
    if (field !== null) {
      matched = [...matched].sort((a, b) => {
        const av = a.data[field] as number;
        const bv = b.data[field] as number;
        return av !== bv ? av - bv : a.id.localeCompare(b.id);
      });
    }

    if (this.startAfterSnap !== null && field !== null) {
      const { orderValue, id } = this.startAfterSnap;
      matched = matched.filter((d) => {
        const v = d.data[field] as number;
        return v > orderValue || (v === orderValue && d.id.localeCompare(id) > 0);
      });
    }

    if (this.limitN !== null) {
      matched = matched.slice(0, this.limitN);
    }

    return { docs: matched.map((d) => ({ id: d.id, data: () => ({ ...d.data }) })) };
  }
}

class FakeFirestore {
  private readonly collections = new Map<string, StoredDoc[]>();
  private readonly docs = new Map<string, Record<string, unknown>>();

  seed(collectionName: string, doc: StoredDoc): void {
    const list = this.collections.get(collectionName) ?? [];
    list.push({ id: doc.id, data: { ...doc.data } });
    this.collections.set(collectionName, list);
  }

  seedDoc(path: string, data: Record<string, unknown>): void {
    this.docs.set(path, { ...data });
  }

  getDoc(path: string): Record<string, unknown> | undefined {
    const direct = this.docs.get(path);
    if (direct !== undefined) {
      return direct;
    }
    // Fall back to a `collection/{id}` lookup so a doc-id cursor re-read on a
    // seeded collection (e.g. `deviceAuditLogs/{id}`) resolves.
    const slash = path.lastIndexOf('/');
    if (slash > 0) {
      const collectionName = path.slice(0, slash);
      const id = path.slice(slash + 1);
      const found = this.collectionDocs(collectionName).find((d) => d.id === id);
      if (found) {
        return found.data;
      }
    }
    return undefined;
  }

  collectionDocs(collectionName: string): StoredDoc[] {
    return this.collections.get(collectionName) ?? [];
  }

  collection(name: string): FakeQuery {
    return new FakeQuery(this, name);
  }
}

/** Seed a tenant-scoped device doc at the path fetchTimeline reads. */
function seedScopedDevice(db: FakeFirestore, tenantId = TENANT): void {
  db.seedDoc(`user_devices/${EMAIL}/devices/${DEVICE}`, { tenantIds: [tenantId] });
}

/** Seed one audit row for the target tenant+device. */
function seedAudit(db: FakeFirestore, id: string, actionTimeMs: number): void {
  db.seed(DEVICE_AUDIT_LOG_COLLECTION, {
    id,
    data: {
      tenantId: TENANT,
      targetDeviceId: DEVICE,
      action: 'force_logout',
      actionTimeMs,
      createdAt: new Date(actionTimeMs).toISOString(),
    },
  });
}

describe('fetchTimeline — existence + tenant-scope checks (FIX 5A)', () => {
  it('throws DeviceNotFoundError (404) when the device does not exist', async () => {
    const db = new FakeFirestore();
    // No device doc seeded; an audit row for the device must NOT mask the 404.
    seedAudit(db, 'a', 1000);
    mockedGetFirestore.mockReturnValue(db as never);

    await expect(
      fetchTimeline({ tenantId: TENANT, email: EMAIL, deviceId: DEVICE })
    ).rejects.toBeInstanceOf(DeviceNotFoundError);

    try {
      await fetchTimeline({ tenantId: TENANT, email: EMAIL, deviceId: DEVICE });
    } catch (err) {
      expect((err as DeviceNotFoundError).code).toBe('device_not_found');
      expect((err as DeviceNotFoundError).status).toBe(404);
    }
  });

  it('throws TenantScopeError (403) when the device is scoped to another tenant', async () => {
    const db = new FakeFirestore();
    seedScopedDevice(db, 'other-tenant');
    seedAudit(db, 'a', 1000);
    mockedGetFirestore.mockReturnValue(db as never);

    await expect(
      fetchTimeline({ tenantId: TENANT, email: EMAIL, deviceId: DEVICE })
    ).rejects.toBeInstanceOf(TenantScopeError);

    try {
      await fetchTimeline({ tenantId: TENANT, email: EMAIL, deviceId: DEVICE });
    } catch (err) {
      expect((err as TenantScopeError).code).toBe('tenant_scope_violation');
      expect((err as TenantScopeError).status).toBe(403);
    }
  });

  it('returns an empty entries array (200) for an in-scope device with no audit rows', async () => {
    const db = new FakeFirestore();
    seedScopedDevice(db);
    mockedGetFirestore.mockReturnValue(db as never);

    const result = await fetchTimeline({ tenantId: TENANT, email: EMAIL, deviceId: DEVICE });

    expect(result.ok).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result).not.toHaveProperty('nextCursor');
  });
});

describe('fetchTimeline — pagination (FIX 5A)', () => {
  it('paginates ascending with hasMore / nextCursor and joins pages without gaps or overlaps', async () => {
    const db = new FakeFirestore();
    seedScopedDevice(db);
    // Five distinct-time rows (ascending ids so id order matches time order).
    seedAudit(db, 'e1', 1000);
    seedAudit(db, 'e2', 2000);
    seedAudit(db, 'e3', 3000);
    seedAudit(db, 'e4', 4000);
    seedAudit(db, 'e5', 5000);
    mockedGetFirestore.mockReturnValue(db as never);

    // Page 1 (limit 2): oldest two, hasMore true, cursor = last of page.
    const page1 = await fetchTimeline({
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      limit: 2,
    });
    expect(page1.entries.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe('e2');

    // Page 2: next two, still more.
    const page2 = await fetchTimeline({
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.entries.map((e) => e.id)).toEqual(['e3', 'e4']);
    expect(page2.hasMore).toBe(true);
    expect(page2.nextCursor).toBe('e4');

    // Page 3: final row, hasMore false, no nextCursor.
    const page3 = await fetchTimeline({
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.entries.map((e) => e.id)).toEqual(['e5']);
    expect(page3.hasMore).toBe(false);
    expect(page3).not.toHaveProperty('nextCursor');

    // The three pages concatenate to the full, in-order, duplicate-free set.
    const all = [...page1.entries, ...page2.entries, ...page3.entries].map((e) => e.id);
    expect(all).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(new Set(all).size).toBe(all.length);
  });

  it('returns hasMore false and omits nextCursor when the page fits in one request', async () => {
    const db = new FakeFirestore();
    seedScopedDevice(db);
    seedAudit(db, 'e1', 1000);
    seedAudit(db, 'e2', 2000);
    mockedGetFirestore.mockReturnValue(db as never);

    const result = await fetchTimeline({
      tenantId: TENANT,
      email: EMAIL,
      deviceId: DEVICE,
      limit: 10,
    });

    expect(result.entries.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(result.hasMore).toBe(false);
    expect(result).not.toHaveProperty('nextCursor');
  });
});
