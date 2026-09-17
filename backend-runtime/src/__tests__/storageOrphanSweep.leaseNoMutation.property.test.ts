// Feature: storage-sweep-scale-hardening, Property 5: Report mode still mutates nothing outside the maintenance namespace, with the lease in place and transactions observed
/**
 * Property 5: Report mode still mutates nothing outside the maintenance namespace,
 * with the lease in place and transactions observed
 * **Validates: Requirements 5.13, 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 6.10**
 *
 * *For any* tenant, *any* reference-source content, *any* generated bucket listing
 * (including one in which every object is unreferenced) and *any* lease state, a run
 * with `mode: 'report'` — and equally `mode: 'sweep'` with `apply: false` — invokes
 * no mutating bucket method, no Realtime Database
 * `set`/`update`/`remove`/`push`/`transaction`, and **no Firestore write outside
 * `storageMaintenanceJobs/`, whether issued directly or inside a transaction**.
 *
 * ── Why this is its own file, and why the parent's Property 6 file is UNTOUCHED ──
 *
 * `storageOrphanSweep.reportNoMutation.property.test.ts` carries the tag
 * `// Feature: storage-orphan-cleanup, Property 6:` and Req 11.5 requires every
 * property file for *this* feature to be tagged for this feature — so extending that
 * file in place would satisfy one criterion by breaking another. The resolution is
 * the one `design.md` records: the transaction-aware observation went into the
 * **shared harness** (spec task 2.1), so the parent's file became strictly stronger
 * with **no edit at all** — its `foreignWrites` filter already selects every
 * `kind: 'write'` outside `storageMaintenanceJobs/`, and `tx.set` is now logged as
 * one. This file then asserts the same predicate *with a lease installed*.
 *
 * ── The widening is the point, and so is what the predicate STAYS ───────────────
 *
 * The recording fake once logged only `.set`, so a lease written to `jobLeases/`
 * inside a transaction would have passed an assertion stated as "no write outside
 * `storageMaintenanceJobs/`". The harness now logs `tx.set`, `tx.update` and
 * `tx.delete` **at the call site rather than at commit**, so a transactional write
 * that later aborts still fails this property — the log records intent, the document
 * store records outcome.
 *
 * What does *not* change is the shape of the predicate: **one namespace prefix,
 * never an enumerated allow-list** (Req 6.4). That is the whole reason the Run_Lease
 * lives at `storageMaintenanceJobs/orphanSweep/leases/run` rather than in
 * `jobLeases/`, and it is asserted below as a single `startsWith` over every write
 * the run performed — the same one sentence a maintainer reads before a destructive
 * run. The parent's Property 6 statement, its assertion and its meaning are all
 * unchanged (Req 6.3).
 */

import * as fc from 'fast-check';

import { STORAGE_TENANT_CATEGORIES } from '../lib/storageObjectRef';
import { runStorageOrphanSweep, tenantReportPath } from '../jobs/storageOrphanSweep';
import {
  ORPHAN_SWEEP_LEASE_COLLECTION,
  RUN_LEASE_JOB_NAME,
  acquireRunLease,
  runLeasePath,
  type RunLeaseHandle,
} from '../jobs/storageOrphanSweepLease';
import {
  createFakeBucket,
  createFakeFirestore,
  createFakeRtdb,
  createOperationLog,
  downloadUrl,
  iso,
  sweepConfig,
  type DocData,
  type FakeObject,
} from './support/storageOrphanSweepHarness';

const TENANT = 'acme';
const NOW = Date.parse('2026-04-01T00:00:00Z');
const DAY = 86_400_000;

/** The Maintenance_Namespace, as ONE prefix. Never a list. */
const MAINTENANCE_NAMESPACE = 'storageMaintenanceJobs/';
/** The Lease_Namespace, four segments deep inside it (Reqs 6.1, 6.10). */
const LEASE_NAMESPACE = `${ORPHAN_SWEEP_LEASE_COLLECTION}/`;

/** Every bucket mutator, and the two ways to obtain a writer. */
const FORBIDDEN_BUCKET_METHODS = [
  'bucket.file.save',
  'bucket.file.copy',
  'bucket.file.delete',
  'bucket.file.move',
  'bucket.file.setMetadata',
  'bucket.file.makePublic',
  'bucket.file.createWriteStream',
];

/** Every Realtime Database mutator. */
const FORBIDDEN_RTDB_METHODS = [
  'rtdb.set',
  'rtdb.update',
  'rtdb.remove',
  'rtdb.push',
  'rtdb.transaction',
];

/**
 * The ten fields `RunLeaseDoc` declares, and the whole of what the Lease_Namespace
 * may contain (Req 6.5). An eleventh key is a contract change, not an extension.
 */
const LEASE_FIELDS = [
  'jobName',
  'token',
  'runnerId',
  'sweepId',
  'mode',
  'acquiredAtMs',
  'acquiredAtIso',
  'expiresAtMs',
  'renewals',
  'updatedAt',
].sort();

// ─── Generators: the parent Property 6 fixtures, re-run with a lease ──────────

type MetadataShape = 'both' | 'createdOnly' | 'updatedOnly' | 'none';

interface GeneratedObject {
  category: string;
  slug: string;
  ageDays: number;
  size: number;
  referenced: boolean;
  metadataShape: MetadataShape;
  /** Which Reference_Source proves it, when it is referenced at all. */
  via: 'notice_path' | 'fee_receipt' | 'chat_message';
}

/** A short hex slug. `fc.hexaString` was removed in fast-check v4. */
const hexSlugArb = fc.integer({ min: 0x1000, max: 0xffffff }).map((value) => value.toString(16));

const generatedObjectArb: fc.Arbitrary<GeneratedObject> = fc.record({
  category: fc.constantFrom(...STORAGE_TENANT_CATEGORIES),
  slug: hexSlugArb,
  ageDays: fc.integer({ min: 0, max: 400 }),
  size: fc.integer({ min: 0, max: 5_000_000 }),
  referenced: fc.boolean(),
  metadataShape: fc.constantFrom<MetadataShape>('both', 'createdOnly', 'updatedOnly', 'none'),
  via: fc.constantFrom<GeneratedObject['via']>('notice_path', 'fee_receipt', 'chat_message'),
});

/**
 * The three non-mutating mode combinations, exactly as the parent's Property 6
 * generates them. `mode: 'report'` with `apply: true` is included deliberately: only
 * `sweep` AND `apply` may mutate, so a single mistyped switch must still be inert.
 * All three acquire the lease, which is Req 5.13.
 */
const reportModeArb = fc.constantFrom(
  { mode: 'report' as const, apply: false },
  { mode: 'report' as const, apply: true },
  { mode: 'sweep' as const, apply: false }
);

/**
 * The generated lease state.
 *
 * All four are **acquirable** — an absent, past, non-numeric or non-finite
 * `expiresAtMs` is a lease nobody holds — so every generated run reaches the sweep
 * and the lease document is always written. The declined state has its own property:
 * a declined run performs no run at all, which is Property 4's clause 2, and folding
 * it in here would turn "the lease document is written" into a conditional and give
 * this property a silent arm in which it asserts nothing.
 */
type LeaseState = 'absent' | 'expired' | 'expiry_string' | 'expiry_nan';
const leaseStateArb = fc.constantFrom<LeaseState>('absent', 'expired', 'expiry_string', 'expiry_nan');

interface Fixture {
  objects: FakeObject[];
  collections: Record<string, Record<string, DocData>>;
  tree: Record<string, unknown>;
}

function buildFixture(generated: GeneratedObject[]): Fixture {
  const objects = new Map<string, FakeObject>();
  const notices: Record<string, DocData> = {};
  const fees: Record<string, DocData> = {};
  const messages: Record<string, DocData> = {};

  generated.forEach((entry, index) => {
    const extension = entry.category === 'profile-pictures' ? 'jpg' : 'bin';
    const objectPath = `${entry.category}/${TENANT}/${entry.slug}_${index}.${extension}`;
    if (objects.has(objectPath)) return;

    const stamp = iso(NOW - entry.ageDays * DAY);
    objects.set(objectPath, {
      name: objectPath,
      size: entry.size,
      ...(entry.metadataShape === 'both' ? { timeCreated: stamp, updated: stamp } : {}),
      ...(entry.metadataShape === 'createdOnly' ? { timeCreated: stamp } : {}),
      ...(entry.metadataShape === 'updatedOnly' ? { updated: stamp } : {}),
    });

    if (!entry.referenced) return;
    if (entry.via === 'notice_path') {
      notices[`notice_${index}`] = { tenantId: TENANT, imageStoragePath: objectPath };
    } else if (entry.via === 'fee_receipt') {
      fees[`fee_${index}`] = { tenantId: TENANT, receipts: [{ url: downloadUrl(objectPath) }] };
    } else {
      messages[`-msg_${String(index).padStart(4, '0')}`] = {
        sender: 'teacher@example.com',
        recipientId: 'student@example.com',
        fileUrl: downloadUrl(objectPath),
      };
    }
  });

  return {
    objects: Array.from(objects.values()),
    collections: { notices, fees },
    tree: { tenantChat: { [TENANT]: { conversationMessages: { c_1: messages } } } },
  };
}

/** Install the generated pre-existing lease record. Every shape here is acquirable. */
function installLeaseState(documents: Map<string, DocData>, state: LeaseState): void {
  if (state === 'absent') return;
  const expiresAtMs: unknown =
    state === 'expired' ? NOW - 1_000 : state === 'expiry_string' ? '2026-04-01T01:00:00Z' : Number.NaN;
  documents.set(runLeasePath(), {
    jobName: RUN_LEASE_JOB_NAME,
    token: 'stale-token',
    runnerId: 'stale-runner',
    sweepId: 'sweep_stale_0001',
    mode: 'report',
    acquiredAtMs: NOW - 60 * 60_000,
    acquiredAtIso: new Date(NOW - 60 * 60_000).toISOString(),
    expiresAtMs,
    renewals: 0,
    updatedAt: new Date(NOW - 60 * 60_000),
  });
}

// ─── The assertions, shared by both cases ────────────────────────────────────

interface Observed {
  invoked: Set<string>;
  writes: { store: string; method: string; target: string }[];
}

/**
 * The single-prefix predicate, and the whole of Req 6.4: one `startsWith`, applied
 * to every write of every store. Nothing here enumerates a permitted collection.
 */
function foreignWrites(observed: Observed): Observed['writes'] {
  return observed.writes.filter(
    (entry) => entry.store !== 'firestore' || !entry.target.startsWith(MAINTENANCE_NAMESPACE)
  );
}

function assertNoMutationOutsideTheNamespace(observed: Observed): void {
  for (const method of FORBIDDEN_BUCKET_METHODS) expect(observed.invoked.has(method)).toBe(false);
  for (const method of FORBIDDEN_RTDB_METHODS) expect(observed.invoked.has(method)).toBe(false);
  expect(foreignWrites(observed)).toEqual([]);
}

/**
 * The lease write itself: inside the Lease_Namespace, and carrying nothing but this
 * job's own bookkeeping.
 *
 * Both halves matter. The path is what keeps Property 6's predicate a prefix, and
 * the field set is Req 6.5 — a document that landed in the right place while
 * carrying a tenant record would satisfy the prefix and violate the requirement the
 * prefix exists to express.
 */
function assertLeaseDocument(documents: Map<string, DocData>, writes: Observed['writes']): void {
  const leaseWrites = writes.filter((entry) => entry.target.startsWith(LEASE_NAMESPACE));
  expect(leaseWrites.length).toBeGreaterThan(0);
  for (const entry of leaseWrites) {
    expect(entry.store).toBe('firestore');
    expect(entry.method.startsWith('tx.')).toBe(true);
    expect(entry.target).toBe(runLeasePath());
    // The prefix is checked in its own right, not implied by the exact path above:
    // this is the clause Property 6's single-predicate form depends on.
    expect(entry.target.startsWith(MAINTENANCE_NAMESPACE)).toBe(true);
  }

  const lease = documents.get(runLeasePath());
  expect(lease).toBeDefined();
  expect(Object.keys(lease!).sort()).toEqual(LEASE_FIELDS);
  expect(lease!.jobName).toBe(RUN_LEASE_JOB_NAME);

  // No application data (Req 6.5): every recorded value is a scalar this job minted,
  // and none of them is an object path, a filename, an email address or a URL.
  const serialised = JSON.stringify(lease);
  expect(serialised).not.toContain('@');
  expect(serialised).not.toContain('http');
  expect(serialised).not.toContain('.bin');
  expect(serialised).not.toContain('.jpg');
  for (const category of STORAGE_TENANT_CATEGORIES) {
    expect(serialised).not.toContain(`${category}/`);
  }
}

// ─── The property ────────────────────────────────────────────────────────────

let consoleLog: jest.SpyInstance;
let consoleWarn: jest.SpyInstance;

beforeAll(() => {
  consoleLog = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  consoleLog.mockRestore();
  consoleWarn.mockRestore();
});

/**
 * One run, with the lease acquired before the core is entered and released after —
 * the runner's own order (Req 5.1), and the only reason this test file has a
 * simulation at all: `main()` is unexported.
 */
async function runWithLease(args: {
  fixture: Fixture;
  mode: { mode: 'report' | 'sweep'; apply: boolean };
  leaseState: LeaseState;
  pageSize: number;
}): Promise<{ observed: Observed; documents: Map<string, DocData>; leaseToken: string }> {
  const log = createOperationLog();
  const bucket = createFakeBucket({ log, objects: args.fixture.objects });
  const db = createFakeFirestore({ log, collections: args.fixture.collections });
  const rtdb = createFakeRtdb({ log, tree: args.fixture.tree });
  installLeaseState(db.documents, args.leaseState);

  const sweepId = 'sweep_lease_nomut_0001';
  const acquisition = await acquireRunLease({
    db: db as never,
    runnerId: 'test-runner',
    sweepId,
    mode: args.mode.mode,
    nowMs: NOW,
  });
  // Every generated lease state is acquirable, so this is a fact about the run rather
  // than a branch: a decline here would mean the state generator drifted.
  expect(acquisition.ok).toBe(true);
  const handle: RunLeaseHandle = (acquisition as { handle: RunLeaseHandle }).handle;

  try {
    await runStorageOrphanSweep({
      db: db as never,
      rtdb: rtdb as never,
      bucket: bucket as never,
      config: sweepConfig({
        ...args.mode,
        pageSize: args.pageSize,
        nowMs: NOW,
        sweepId,
        leaseToken: handle.token,
      }) as never,
      renewRunLease: () => handle.renew(NOW),
    });
  } finally {
    // Released in a `finally` on completion and on failure alike (Req 5.6). The
    // release is a `tx.delete` INSIDE the namespace, so it is observed by the same
    // predicate as the write.
    await handle.release();
  }

  return {
    observed: {
      invoked: new Set(log.methods()),
      writes: log.writes().map((entry) => ({
        store: entry.store,
        method: entry.method,
        target: entry.target,
      })),
    },
    documents: db.documents,
    leaseToken: handle.token,
  };
}

describe('Property 5: report mode mutates nothing outside the maintenance namespace, with the lease installed', () => {
  it('writes the lease inside storageMaintenanceJobs/ and nothing else anywhere', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(generatedObjectArb, { minLength: 0, maxLength: 14 }),
        reportModeArb,
        fc.integer({ min: 1, max: 4 }),
        leaseStateArb,
        async (generated, mode, pageSize, leaseState) => {
          const fixture = buildFixture(generated);
          const { observed, documents, leaseToken } = await runWithLease({
            fixture,
            mode,
            leaseState,
            pageSize,
          });

          // 1–3. No bucket mutator, no RTDB write, and no Firestore write outside the
          //      one namespace — whether issued directly or inside a transaction.
          assertNoMutationOutsideTheNamespace(observed);

          // 4. The transactional writes were observed at all, which is what makes the
          //    clause above stronger than it was before task 2.1: a `jobLeases/` lease
          //    would now appear in `foreignWrites` rather than being invisible.
          expect(observed.invoked.has('firestore.tx.get')).toBe(true);
          expect(observed.invoked.has('firestore.tx.set')).toBe(true);
          expect(observed.invoked.has('firestore.tx.delete')).toBe(true);

          // 5. Req 6.2 — no write to `jobLeases/` anywhere, stated as its own clause
          //    because it is the collection this spec deliberately did NOT use.
          expect(observed.writes.some((entry) => entry.target.startsWith('jobLeases/'))).toBe(false);

          // 6. The lease document's PATH (Reqs 6.1, 6.10), read off the write log
          //    rather than off the store: this arm releases in its `finally`, so by now
          //    the document is correctly gone. The field set is asserted in the second
          //    case below, which holds the lease open to look at it.
          const leaseWrites = observed.writes.filter((entry) =>
            entry.target.startsWith(LEASE_NAMESPACE)
          );
          expect(leaseWrites.length).toBeGreaterThan(0);
          for (const entry of leaseWrites) {
            expect(entry.target).toBe(runLeasePath());
            expect(entry.target.startsWith(MAINTENANCE_NAMESPACE)).toBe(true);
          }
          // The token this run held is a fence, not a credential, and it is the only
          // lease value the Report_Document records.
          expect(typeof leaseToken).toBe('string');

          // 7. The quota record is still NOT written, and the recomputed value still IS
          //    recorded — the parent's Property 6 clause, unchanged with a lease in
          //    place.
          expect(documents.get(`tenantStorageUsage/${TENANT}`)).toBeUndefined();
          const report = documents.get(tenantReportPath(TENANT));
          expect(report).toBeDefined();
          expect(report!.applied).toBe(false);
          expect(report!.quarantinedCount).toBe(0);
          expect(typeof report!.usageBytesAfter).toBe('number');
          // Req 6.10 — the Report_Document path is unchanged, and it is NOT in the
          // Lease_Namespace.
          expect(tenantReportPath(TENANT)).toBe(`storageMaintenanceJobs/orphanSweep/tenants/${TENANT}`);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * The fixture in which **every** object is unreferenced, which is the one that
   * exercises the whole orphan-candidate path in report mode: every disposition is
   * `orphan`, so if any code path could reach a mover, this is the shape that reaches
   * it. Held separately so the lease document's field set is asserted against a run
   * that examined a bucket entirely made of candidates.
   */
  it('mutates nothing and records no application data when every object is unreferenced', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            category: fc.constantFrom(...STORAGE_TENANT_CATEGORIES),
            slug: hexSlugArb,
            ageDays: fc.integer({ min: 8, max: 900 }),
            size: fc.integer({ min: 1, max: 1_000 }),
          }),
          { minLength: 1, maxLength: 12 }
        ),
        reportModeArb,
        leaseStateArb,
        async (entries, mode, leaseState) => {
          const objects: FakeObject[] = entries.map((entry, index) => {
            const stamp = iso(NOW - entry.ageDays * DAY);
            return {
              name: `${entry.category}/${TENANT}/${entry.slug}_${index}.bin`,
              size: entry.size,
              timeCreated: stamp,
              updated: stamp,
            };
          });

          const log = createOperationLog();
          const bucket = createFakeBucket({ log, objects });
          // No reference source holds anything at all.
          const db = createFakeFirestore({ log, collections: {} });
          const rtdb = createFakeRtdb({ log, tree: {} });
          installLeaseState(db.documents, leaseState);

          const acquisition = await acquireRunLease({
            db: db as never,
            runnerId: 'test-runner',
            sweepId: 'sweep_lease_nomut_0002',
            mode: mode.mode,
            nowMs: NOW,
          });
          expect(acquisition.ok).toBe(true);
          const handle: RunLeaseHandle = (acquisition as { handle: RunLeaseHandle }).handle;

          const run = await runStorageOrphanSweep({
            db: db as never,
            rtdb: rtdb as never,
            bucket: bucket as never,
            config: sweepConfig({
              ...mode,
              nowMs: NOW,
              pageSize: 3,
              sweepId: 'sweep_lease_nomut_0002',
              leaseToken: handle.token,
            }) as never,
            renewRunLease: () => handle.renew(NOW),
          });

          const observed: Observed = {
            invoked: new Set(log.methods()),
            writes: log.writes().map((entry) => ({
              store: entry.store,
              method: entry.method,
              target: entry.target,
            })),
          };

          // Every candidate examined, and still nothing mutated anywhere.
          const [result] = run.tenants;
          expect(result.status).toBe('completed');
          expect(result.quarantinedCount).toBe(0);
          assertNoMutationOutsideTheNamespace(observed);

          // The lease document, asserted BEFORE the release removes it: the ten
          // declared fields and no application data (Req 6.5).
          assertLeaseDocument(db.documents, observed.writes);

          // And the release is itself inside the namespace, so the predicate covers
          // the whole lifecycle rather than only the acquisition.
          await handle.release();
          const afterRelease: Observed = {
            invoked: new Set(log.methods()),
            writes: log.writes().map((entry) => ({
              store: entry.store,
              method: entry.method,
              target: entry.target,
            })),
          };
          assertNoMutationOutsideTheNamespace(afterRelease);
          expect(db.documents.get(runLeasePath())).toBeUndefined();
          expect(db.documents.get(`tenantStorageUsage/${TENANT}`)).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });
});
