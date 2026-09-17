/**
 * Storage orphan sweep — the RUNNER's gates (spec task 10.5).
 *
 * Every gate lives in `runStorageOrphanSweep.ts` rather than in the core, and each
 * one is exported as a pure seam — `parseBooleanEnv`, `parsePositiveIntEnv`,
 * `parseTenantIdsEnv`, `loadRunnerConfig(env)` and `decideStartup(config)` — so the
 * gates are assertable against a STUBBED environment without spawning a process,
 * without touching `process.env`, and without the job ever being in a position to
 * run. `main()` is invoked only under `require.main === module`, so importing the
 * module here cannot start one; the last describe block asserts exactly that
 * rather than assuming it.
 *
 * Three mocks, each for a stated reason:
 *
 *  - `dotenv/config`, so importing the runner does not load `backend-runtime/.env`
 *    into `process.env`. Jest runs the suites of one worker in a single process, so
 *    that would leak real configuration into every suite scheduled after this one
 *    — and the whole point here is that the environment is the test's, stubbed and
 *    explicit.
 *  - `firebase-admin`, with recording functions, so "no Firebase initialisation"
 *    is checkable rather than asserted by inspection.
 *  - `tenantUsageRollup`, whose `initFirebase` is the runner's only init path.
 *
 * `storageOrphanSweep` is mocked only PARTIALLY (`jest.requireActual` plus two
 * recorded entrypoints): the real `DEFAULT_*` constants must come through, because
 * a test that mocked away the defaults would assert the fallbacks against itself.
 *
 * _Requirements: 5.7, 10.8, 10.9, 10.10, 10.11_
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import v8 from 'node:v8';

import { DEFAULT_GRACE_DAYS, DEFAULT_QUARANTINE_RETENTION_DAYS } from '../lib/orphanDecision';
// The two pure decisions behind the heap refusal and the start-up line
// (storage-sweep-scale-hardening task 8.7). Imported at the top like
// `orphanDecision` above rather than beside the cases that use them: neither module is
// mocked, so neither is subject to the mock-factory ordering the lazy `loadRunner()`
// below exists for.
import {
  DEFAULT_HEAP_GUARD_FRACTION,
  estimateRetainSetFootprintBytes,
  heapGuardBytes,
} from '../lib/sweepScaleLimits';

// The runner module is loaded with `require` INSIDE the tests, never statically:
// a static import would run the mock factories below before these `const`s were
// initialised.
type RunnerModule = typeof import('../jobs/runStorageOrphanSweep');

/** Every side effect that would mean the job actually started. */
const sideEffects = {
  sweepCoreCalls: 0,
  purgeCalls: 0,
  initFirebaseCalls: 0,
  shutdownFirebaseCalls: 0,
  adminInitializeAppCalls: 0,
  adminFirestoreCalls: 0,
  adminDatabaseCalls: 0,
  adminStorageCalls: 0,
};

jest.mock('dotenv/config', () => ({}));

jest.mock('firebase-admin', () => {
  const fail = (name: string) => () => {
    throw new Error(`firebase-admin.${name}() must not be reached by this suite`);
  };
  return {
    initializeApp: () => {
      sideEffects.adminInitializeAppCalls += 1;
      return {};
    },
    credential: { applicationDefault: () => ({}), cert: () => ({}) },
    apps: [],
    firestore: () => {
      sideEffects.adminFirestoreCalls += 1;
      return fail('firestore')();
    },
    database: () => {
      sideEffects.adminDatabaseCalls += 1;
      return fail('database')();
    },
    storage: () => {
      sideEffects.adminStorageCalls += 1;
      return fail('storage')();
    },
  };
});

jest.mock('../jobs/tenantUsageRollup', () => ({
  initFirebase: () => {
    sideEffects.initFirebaseCalls += 1;
  },
  shutdownFirebase: async () => {
    sideEffects.shutdownFirebaseCalls += 1;
  },
}));

jest.mock('../jobs/storageOrphanSweep', () => {
  const actual = jest.requireActual('../jobs/storageOrphanSweep');
  return {
    ...actual,
    runStorageOrphanSweep: async () => {
      sideEffects.sweepCoreCalls += 1;
      throw new Error('the sweep core must not be reached by this suite');
    },
    purgeExpiredQuarantine: async () => {
      sideEffects.purgeCalls += 1;
      throw new Error('the purge stage must not be reached by this suite');
    },
  };
});

function loadRunner(): RunnerModule {
  // A lazy `require` on purpose, and the one place this file uses one: a static
  // import would run the mock factories above before the `sideEffects` object they
  // close over existed. `jest.requireMock` is not the alternative — the runner is
  // not mocked, only its dependencies are, so requiring it must return the REAL
  // gates.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../jobs/runStorageOrphanSweep') as RunnerModule;
}

/**
 * The documented defaults, written as literals on purpose: the point of Req 10.11
 * is that a bad value falls back to the number the operator was told about, so
 * reading the expectation out of the same constant the implementation reads would
 * assert nothing. `documented defaults match the exported constants` below closes
 * the loop.
 */
const DOCUMENTED_DEFAULTS = {
  STORAGE_ORPHAN_SWEEP_GRACE_DAYS: 7,
  STORAGE_ORPHAN_SWEEP_QUARANTINE_RETENTION_DAYS: 7,
  STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT: 1000,
  STORAGE_ORPHAN_SWEEP_PAGE_SIZE: 1000,
  // CHANGED, deliberately and by exactly one literal (spec task 8.1, Req 8.1):
  // `2_000_000` → `500_000`. The table holds the documented defaults as literals on
  // purpose — see the comment above — so a deliberate change to a documented default
  // is an edit to the literal, and `documented defaults match the exported constants`
  // below is what makes the edit an assertion rather than a rubber stamp. At 232 B
  // per retained path, 2,000,000 estimated at ≈ 464 MB, which fits neither a `512Mi`
  // container nor the 627 MB guard a `1Gi` container with a declared 896 MB old-space
  // limit produces: the documented `reference_cap_exceeded` abort could not fire
  // because the container was killed first. 500,000 estimates at ≈ 116 MB.
  STORAGE_ORPHAN_SWEEP_MAX_REFERENCES: 500_000,
  // Additive (spec task 5.3). 1000 matches `collectPaymentsReceived`'s page size in
  // `jobs/tenantUsageRollup.ts`, whose keyset loop the Reference_Page_Helper copies.
  STORAGE_ORPHAN_SWEEP_FIRESTORE_PAGE_SIZE: 1000,
  // Additive (spec task 6.3). The report-write cadence: 10 pages is the UPPER bound
  // on write frequency, 30_000 ms the LOWER bound (Req 7.11).
  STORAGE_ORPHAN_SWEEP_REPORT_WRITE_PAGES: 10,
  STORAGE_ORPHAN_SWEEP_REPORT_WRITE_MS: 30_000,
  // Additive (spec task 6.3). 25 OBJECTS, and the number is not arbitrary: it equals
  // the per-tenant Quarantine ceiling `storage-orphan-sweep-job-dev.yaml` documents
  // for a first cautious apply run, so that run writes the Report_Document once at
  // the end of its moves rather than 25 times (Req 7.19). A resolved `0` here would
  // be the write STORM of task 6.2's Defect 2, not a suppressed write — the
  // comparison `movedSinceWrite >= threshold` is made first and unconditionally and
  // the count is never negative — which is why `loadRunnerConfig` floors it at 1
  // (Req 7.21).
  STORAGE_ORPHAN_SWEEP_QUARANTINE_WRITE_THRESHOLD: 25,
  // Additive (spec task 9.2). The Run_Lease duration, 45 minutes in milliseconds —
  // and the number is chosen against the platform rather than picked: it EXCEEDS the
  // `timeoutSeconds: 1800` both Cloud Run Job definitions set, so the platform kills
  // the task before the lease can expire underneath a run that is still working
  // (Req 5.10). `storageOrphanSweepManifests.test.ts` asserts that inequality from
  // the manifests' side. A resolved `0` here would be a lease that had already
  // expired at the instant it was written — no lease at all, while looking like one.
  STORAGE_ORPHAN_SWEEP_LEASE_MS: 2_700_000,
} as const;

/** Config field each numeric variable resolves onto. */
const NUMERIC_FIELDS = {
  STORAGE_ORPHAN_SWEEP_GRACE_DAYS: 'graceDays',
  STORAGE_ORPHAN_SWEEP_QUARANTINE_RETENTION_DAYS: 'quarantineRetentionDays',
  STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT: 'maxQuarantinePerTenant',
  STORAGE_ORPHAN_SWEEP_PAGE_SIZE: 'pageSize',
  STORAGE_ORPHAN_SWEEP_MAX_REFERENCES: 'maxReferences',
  STORAGE_ORPHAN_SWEEP_FIRESTORE_PAGE_SIZE: 'firestorePageSize',
  STORAGE_ORPHAN_SWEEP_REPORT_WRITE_PAGES: 'reportWritePages',
  STORAGE_ORPHAN_SWEEP_REPORT_WRITE_MS: 'reportWriteMs',
  STORAGE_ORPHAN_SWEEP_QUARANTINE_WRITE_THRESHOLD: 'quarantineWriteThreshold',
  STORAGE_ORPHAN_SWEEP_LEASE_MS: 'leaseMs',
} as const;

/**
 * A stubbed environment. Deliberately NOT `process.env`: every gate is a pure
 * function of this object, which is what makes the whole suite side-effect free.
 * `USER`/`USERNAME` are pinned so `runnerId` is deterministic.
 */
function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { USER: undefined, USERNAME: undefined, GITHUB_SHA: undefined, ...overrides };
}

/** The minimum environment that lets the runner start at all. */
function enabledEnv(overrides: Record<string, string | undefined> = {}) {
  return env({
    STORAGE_ORPHAN_SWEEP_ENABLED: '1',
    FIREBASE_DATABASE_URL: 'https://tution-app-6c0c3.firebaseio.com',
    FIREBASE_STORAGE_BUCKET: 'tution-app-6c0c3.firebasestorage.app',
    ...overrides,
  });
}

describe('parseBooleanEnv — only 1/true/yes are true (Req 10.10)', () => {
  const runner = loadRunner();

  it.each(['1', 'true', 'yes', 'TRUE', 'Yes', '  true  '])('%j parses as true', (value) => {
    expect(runner.parseBooleanEnv(value, false)).toBe(true);
  });

  // `on`, `y` and `enabled` are the near-misses worth pinning: they read as
  // affirmative to a human and MUST NOT enable a destructive job.
  it.each(['0', 'false', 'no', 'off', 'on', 'y', 'n', 'enabled', 'YES!', '2', 'truthy', 'null'])(
    '%j does not parse as true',
    (value) => {
      expect(runner.parseBooleanEnv(value, false)).toBe(false);
    }
  );

  it('falls back for an unset, empty or whitespace-only value', () => {
    for (const value of [undefined, null, '', '   ']) {
      expect(runner.parseBooleanEnv(value, false)).toBe(false);
      expect(runner.parseBooleanEnv(value, true)).toBe(true);
    }
  });

  it('a present value overrides the fallback rather than being merged with it', () => {
    expect(runner.parseBooleanEnv('no', true)).toBe(false);
    expect(runner.parseBooleanEnv('1', false)).toBe(true);
  });
});

describe('parsePositiveIntEnv — never zero (Req 10.11)', () => {
  const runner = loadRunner();

  it('accepts a positive integer, trimmed', () => {
    expect(runner.parsePositiveIntEnv('14', 7)).toBe(14);
    expect(runner.parsePositiveIntEnv('  14  ', 7)).toBe(14);
    expect(runner.parsePositiveIntEnv('1', 7)).toBe(1);
  });

  it('truncates a positive non-integer that survives truncation', () => {
    expect(runner.parsePositiveIntEnv('1.9', 7)).toBe(1);
    expect(runner.parsePositiveIntEnv('2.5', 7)).toBe(2);
  });

  /**
   * The specific foot-gun this function exists for. `Number('0.5')` is 0.5:
   * finite, and positive, so a parse-only check passes it — and `Math.trunc(0.5)`
   * is `0`. A `graceDays` of 0 reports every unreferenced object regardless of
   * age, i.e. it silently switches OFF the grace period that protects the
   * non-atomic gap between a successful upload and its record write.
   */
  it('falls back for a value that truncates to zero, not to zero', () => {
    expect(Number('0.5')).toBeGreaterThan(0);
    expect(Number.isFinite(Number('0.5'))).toBe(true);
    expect(Math.trunc(Number('0.5'))).toBe(0);

    expect(runner.parsePositiveIntEnv('0.5', 7)).toBe(7);
    expect(runner.parsePositiveIntEnv('0.999', 1000)).toBe(1000);
    expect(runner.parsePositiveIntEnv('.5', 7)).toBe(7);
  });

  it.each([
    '0',
    '-1',
    '-0.5',
    'abc',
    'Infinity',
    '-Infinity',
    'NaN',
    '',
    '   ',
    '1,000',
    '7 days',
  ])('%j falls back to the documented default', (value) => {
    expect(runner.parsePositiveIntEnv(value, 7)).toBe(7);
  });

  it('never returns zero or a negative number for any of those values', () => {
    for (const value of ['0', '0.5', '-1', 'abc', 'NaN', 'Infinity', '', undefined, null]) {
      const parsed = runner.parsePositiveIntEnv(value, 7);
      expect(parsed).toBeGreaterThan(0);
      expect(Number.isInteger(parsed)).toBe(true);
    }
  });
});

describe('parseTenantIdsEnv', () => {
  const runner = loadRunner();

  it('treats an unset or empty list as all active tenants', () => {
    expect(runner.parseTenantIdsEnv(undefined)).toBe('all_active');
    expect(runner.parseTenantIdsEnv(null)).toBe('all_active');
    expect(runner.parseTenantIdsEnv('')).toBe('all_active');
    expect(runner.parseTenantIdsEnv(' , , ')).toBe('all_active');
  });

  it('trims, de-duplicates and preserves order', () => {
    expect(runner.parseTenantIdsEnv('acme, acme-2 ,acme,, beta ')).toEqual(['acme', 'acme-2', 'beta']);
  });
});

describe('loadRunnerConfig — safe defaults from an empty environment', () => {
  const runner = loadRunner();

  it('defaults every switch to false and every number to its documented default', () => {
    const config = runner.loadRunnerConfig(env());

    expect(config.enabled).toBe(false);
    expect(config.apply).toBe(false);
    expect(config.purgeEnabled).toBe(false);
    expect(config.force).toBe(false);
    expect(config.graceDays).toBe(DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_GRACE_DAYS);
    expect(config.quarantineRetentionDays).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_QUARANTINE_RETENTION_DAYS
    );
    expect(config.maxQuarantinePerTenant).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT
    );
    expect(config.pageSize).toBe(DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_PAGE_SIZE);
    expect(config.maxReferences).toBe(DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_MAX_REFERENCES);
    expect(config.firestorePageSize).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_FIRESTORE_PAGE_SIZE
    );
    expect(config.reportWritePages).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_REPORT_WRITE_PAGES
    );
    expect(config.reportWriteMs).toBe(DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_REPORT_WRITE_MS);
    expect(config.quarantineWriteThreshold).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_QUARANTINE_WRITE_THRESHOLD
    );
    expect(config.leaseMs).toBe(DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_LEASE_MS);
    expect(config.tenantIds).toBe('all_active');
    expect(config.databaseUrl).toBe('');
    expect(config.storageBucket).toBe('');
    expect(config.runnerId).toBe('local-dev');
  });

  it('documented defaults match the constants the implementation uses', () => {
    const sweep = jest.requireActual(
      '../jobs/storageOrphanSweep'
    ) as typeof import('../jobs/storageOrphanSweep');
    expect(DEFAULT_GRACE_DAYS).toBe(DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_GRACE_DAYS);
    expect(DEFAULT_QUARANTINE_RETENTION_DAYS).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_QUARANTINE_RETENTION_DAYS
    );
    expect(sweep.DEFAULT_MAX_QUARANTINE_PER_TENANT).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT
    );
    expect(sweep.DEFAULT_PAGE_SIZE).toBe(DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_PAGE_SIZE);
    expect(sweep.DEFAULT_MAX_REFERENCES).toBe(DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_MAX_REFERENCES);
    expect(sweep.DEFAULT_FIRESTORE_PAGE_SIZE).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_FIRESTORE_PAGE_SIZE
    );
    const limits = jest.requireActual(
      '../lib/sweepScaleLimits'
    ) as typeof import('../lib/sweepScaleLimits');
    expect(limits.DEFAULT_REPORT_WRITE_PAGE_INTERVAL).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_REPORT_WRITE_PAGES
    );
    expect(limits.DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_REPORT_WRITE_MS
    );
    expect(limits.DEFAULT_QUARANTINE_WRITE_THRESHOLD).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_QUARANTINE_WRITE_THRESHOLD
    );
    // Additive (spec task 9.2). The lease default lives beside the document it bounds
    // rather than in `lib/sweepScaleLimits.ts`: it is pure, but it is a property of
    // the lease, and it is the clamp's own default.
    const lease = jest.requireActual(
      '../jobs/storageOrphanSweepLease'
    ) as typeof import('../jobs/storageOrphanSweepLease');
    expect(lease.DEFAULT_RUN_LEASE_MS).toBe(DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_LEASE_MS);
    // The documented default must survive its own clamp — a default outside
    // `[MIN, MAX]` would be silently replaced by the bound, so the number an operator
    // reads in the manifest would not be the number in force.
    expect(lease.clampRunLeaseMs(lease.DEFAULT_RUN_LEASE_MS)).toBe(
      DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_LEASE_MS
    );
  });

  it.each(['0', '0.5', '-1', 'abc', 'Infinity', ''])(
    'each numeric variable set to %j falls back to its own documented default, never zero',
    (value) => {
      for (const [variable, field] of Object.entries(NUMERIC_FIELDS)) {
        const config = runner.loadRunnerConfig(env({ [variable]: value }));
        const resolved = config[field as keyof typeof config] as number;
        expect(resolved).toBe(DOCUMENTED_DEFAULTS[variable as keyof typeof DOCUMENTED_DEFAULTS]);
        expect(resolved).toBeGreaterThan(0);
      }
    }
  );

  it('reads each numeric variable independently', () => {
    const config = runner.loadRunnerConfig(
      env({
        STORAGE_ORPHAN_SWEEP_GRACE_DAYS: '30',
        STORAGE_ORPHAN_SWEEP_QUARANTINE_RETENTION_DAYS: '14',
        STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT: '25',
        STORAGE_ORPHAN_SWEEP_PAGE_SIZE: '200',
        STORAGE_ORPHAN_SWEEP_MAX_REFERENCES: '500',
        STORAGE_ORPHAN_SWEEP_FIRESTORE_PAGE_SIZE: '50',
        STORAGE_ORPHAN_SWEEP_REPORT_WRITE_PAGES: '4',
        STORAGE_ORPHAN_SWEEP_REPORT_WRITE_MS: '5000',
        STORAGE_ORPHAN_SWEEP_QUARANTINE_WRITE_THRESHOLD: '7',
        STORAGE_ORPHAN_SWEEP_LEASE_MS: '600000',
      })
    );
    expect(config.graceDays).toBe(30);
    expect(config.quarantineRetentionDays).toBe(14);
    expect(config.maxQuarantinePerTenant).toBe(25);
    expect(config.pageSize).toBe(200);
    expect(config.maxReferences).toBe(500);
    expect(config.firestorePageSize).toBe(50);
    expect(config.reportWritePages).toBe(4);
    expect(config.reportWriteMs).toBe(5000);
    expect(config.quarantineWriteThreshold).toBe(7);
    // 600_000 is 10 minutes, inside the lease clamp's `[5 min, 6 h]`, so
    // `loadRunnerConfig` reports the configured value unchanged. The clamp itself is
    // applied once in `main()` and is asserted in the lease module's own suite —
    // `loadRunnerConfig` deliberately does not restate it.
    expect(config.leaseMs).toBe(600_000);
  });

  /**
   * Reqs 7.20, 7.21 — the Quarantine_Write_Threshold never resolves to zero, and
   * the reason is the OPPOSITE of what it looks like.
   *
   * A resolved `0` does not suppress the move-driven write. `shouldWriteTenantReport`
   * checks `movedSinceWrite >= threshold` FIRST and UNCONDITIONALLY, and
   * `movedSinceWrite` is never negative, so `0` holds at EVERY evaluation and forces
   * a Report_Document write on every move, every page boundary and every terminal
   * event alike. That is task 6.2's Defect 2 write storm — one write per page to the
   * single document the resume cursor lives on — reached through a configuration that
   * merely looks unusual. Hence the floor at 1 on top of `parsePositiveIntEnv`.
   *
   * Each value gets its own assertion rather than one representative, because `0.5`
   * is the one that survives `parsePositiveIntEnv`'s finite-and-positive guard and is
   * killed only by its truncation check.
   */
  it.each(['0', '-1', '0.5', 'abc', 'Infinity', 'NaN', ''])(
    'a Quarantine_Write_Threshold of %j resolves to 25 and never to 0',
    (value) => {
      const config = runner.loadRunnerConfig(
        env({ STORAGE_ORPHAN_SWEEP_QUARANTINE_WRITE_THRESHOLD: value })
      );
      expect(config.quarantineWriteThreshold).toBe(
        DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_QUARANTINE_WRITE_THRESHOLD
      );
      expect(config.quarantineWriteThreshold).toBeGreaterThanOrEqual(1);
    }
  );

  it('keeps the three switches independent, so no single variable can delete anything', () => {
    const applyOnly = runner.loadRunnerConfig(env({ STORAGE_ORPHAN_SWEEP_APPLY: '1' }));
    expect(applyOnly.apply).toBe(true);
    // Apply without ENABLED is still a no-op run: the enable gate is separate.
    expect(applyOnly.enabled).toBe(false);
    expect(applyOnly.purgeEnabled).toBe(false);

    const purgeOnly = runner.loadRunnerConfig(
      env({ STORAGE_ORPHAN_SWEEP_ENABLED: '1', STORAGE_ORPHAN_SWEEP_PURGE_ENABLED: 'yes' })
    );
    expect(purgeOnly.purgeEnabled).toBe(true);
    expect(purgeOnly.apply).toBe(false);
  });

  it('trims the two handles it refuses to start without', () => {
    const config = runner.loadRunnerConfig(
      env({ FIREBASE_DATABASE_URL: '   ', FIREBASE_STORAGE_BUCKET: '  bucket  ' })
    );
    expect(config.databaseUrl).toBe('');
    expect(config.storageBucket).toBe('bucket');
  });
});

describe('decideStartup — the gate as a value', () => {
  const runner = loadRunner();

  it('not enabled ⇒ skip, before anything else is even checked (Req 10.8)', () => {
    // Deliberately the WORST environment: no database url, no bucket. A disabled
    // job must not fail; it must do nothing.
    const decision = runner.decideStartup(runner.loadRunnerConfig(env()));
    expect(decision.action).toBe('skip');
    if (decision.action !== 'skip') throw new Error('unreachable');
    expect(decision.reason).toBe('disabled');
    expect(decision.message).toContain('STORAGE_ORPHAN_SWEEP_ENABLED');
  });

  it.each(['0', 'false', 'no', 'on', '', undefined])(
    'STORAGE_ORPHAN_SWEEP_ENABLED=%j ⇒ skip',
    (value) => {
      const config = runner.loadRunnerConfig(enabledEnv({ STORAGE_ORPHAN_SWEEP_ENABLED: value }));
      expect(runner.decideStartup(config).action).toBe('skip');
    }
  );

  it('enabled with no FIREBASE_DATABASE_URL ⇒ refuse, explanatorily (Req 5.7)', () => {
    const config = runner.loadRunnerConfig(
      enabledEnv({ FIREBASE_DATABASE_URL: undefined })
    );
    const decision = runner.decideStartup(config);
    expect(decision.action).toBe('refuse');
    if (decision.action !== 'refuse') throw new Error('unreachable');
    expect(decision.reason).toBe('missing_database_url');
    // The message must say WHY, because the misconfiguration it prevents does not
    // look like a failure: it looks like a successful run over a tenant whose
    // whole chat-files/ prefix turned out to be unreferenced.
    expect(decision.message).toContain('FIREBASE_DATABASE_URL');
    expect(decision.message).toMatch(/chat-files/);
    expect(decision.message).toMatch(/refusing to start/i);
  });

  it('enabled with no FIREBASE_STORAGE_BUCKET ⇒ refuse', () => {
    const config = runner.loadRunnerConfig(enabledEnv({ FIREBASE_STORAGE_BUCKET: '  ' }));
    const decision = runner.decideStartup(config);
    expect(decision.action).toBe('refuse');
    if (decision.action !== 'refuse') throw new Error('unreachable');
    expect(decision.reason).toBe('missing_storage_bucket');
    expect(decision.message).toContain('FIREBASE_STORAGE_BUCKET');
  });

  it('a disabled job is skipped rather than refused, even when misconfigured', () => {
    const config = runner.loadRunnerConfig(
      env({ FIREBASE_DATABASE_URL: undefined, FIREBASE_STORAGE_BUCKET: undefined })
    );
    expect(runner.decideStartup(config).action).toBe('skip');
  });

  it('apply absent ⇒ report mode (Req 10.9)', () => {
    const decision = runner.decideStartup(runner.loadRunnerConfig(enabledEnv()));
    expect(decision).toEqual({ action: 'run', mode: 'report', apply: false, purgeEnabled: false });
  });

  it.each(['0', 'false', 'no', 'on', 'y', '', undefined])(
    'STORAGE_ORPHAN_SWEEP_APPLY=%j ⇒ report mode',
    (value) => {
      const config = runner.loadRunnerConfig(enabledEnv({ STORAGE_ORPHAN_SWEEP_APPLY: value }));
      const decision = runner.decideStartup(config);
      expect(decision.action).toBe('run');
      if (decision.action !== 'run') throw new Error('unreachable');
      expect(decision.mode).toBe('report');
      expect(decision.apply).toBe(false);
    }
  );

  it.each(['1', 'true', 'yes'])('STORAGE_ORPHAN_SWEEP_APPLY=%j ⇒ sweep mode', (value) => {
    const config = runner.loadRunnerConfig(enabledEnv({ STORAGE_ORPHAN_SWEEP_APPLY: value }));
    const decision = runner.decideStartup(config);
    expect(decision.action).toBe('run');
    if (decision.action !== 'run') throw new Error('unreachable');
    expect(decision.mode).toBe('sweep');
    expect(decision.apply).toBe(true);
  });

  it('carries the purge switch through independently of apply', () => {
    const decision = runner.decideStartup(
      runner.loadRunnerConfig(enabledEnv({ STORAGE_ORPHAN_SWEEP_PURGE_ENABLED: '1' }))
    );
    expect(decision).toEqual({ action: 'run', mode: 'report', apply: false, purgeEnabled: true });
  });
});

describe('importing the module starts nothing', () => {
  it('does not run the sweep, the purge, or any Firebase initialisation', () => {
    jest.resetModules();
    const before = { ...sideEffects };

    const runner = loadRunner();

    // The seams are there…
    expect(typeof runner.loadRunnerConfig).toBe('function');
    expect(typeof runner.decideStartup).toBe('function');
    // …and `main` is not exported at all, so nothing but `require.main === module`
    // can invoke it.
    expect((runner as Record<string, unknown>).main).toBeUndefined();

    // …and nothing ran. `main()` is guarded by `require.main === module`, which is
    // the jest runner here, not this module.
    expect(sideEffects.sweepCoreCalls).toBe(before.sweepCoreCalls);
    expect(sideEffects.purgeCalls).toBe(before.purgeCalls);
    expect(sideEffects.initFirebaseCalls).toBe(before.initFirebaseCalls);
    expect(sideEffects.shutdownFirebaseCalls).toBe(before.shutdownFirebaseCalls);
    expect(sideEffects.adminInitializeAppCalls).toBe(before.adminInitializeAppCalls);
    expect(sideEffects.adminFirestoreCalls).toBe(before.adminFirestoreCalls);
    expect(sideEffects.adminDatabaseCalls).toBe(before.adminDatabaseCalls);
    expect(sideEffects.adminStorageCalls).toBe(before.adminStorageCalls);
  });

  it('and none of the gates touch Firebase either', () => {
    const runner = loadRunner();
    // The full decision path, for every combination that matters, with zero
    // initialisation: skip, both refusals, report and apply.
    for (const overrides of [
      env(),
      enabledEnv({ FIREBASE_DATABASE_URL: undefined }),
      enabledEnv({ FIREBASE_STORAGE_BUCKET: undefined }),
      enabledEnv(),
      enabledEnv({ STORAGE_ORPHAN_SWEEP_APPLY: '1', STORAGE_ORPHAN_SWEEP_PURGE_ENABLED: '1' }),
    ]) {
      runner.decideStartup(runner.loadRunnerConfig(overrides));
    }

    expect(sideEffects.initFirebaseCalls).toBe(0);
    expect(sideEffects.adminInitializeAppCalls).toBe(0);
    expect(sideEffects.adminFirestoreCalls).toBe(0);
    expect(sideEffects.adminDatabaseCalls).toBe(0);
    expect(sideEffects.adminStorageCalls).toBe(0);
    expect(sideEffects.sweepCoreCalls).toBe(0);
    expect(sideEffects.purgeCalls).toBe(0);
  });
});

// ─── The exit code and the run summary (storage-sweep-scale-hardening 3.6) ────
//
// Additive: nothing above is edited. `main()` is reachable only under
// `require.main === module`, so the summary LINE itself is unobservable from here by
// design — what is assertable, and what the line is only as good as, are the three
// counts it reads off the core's result. Those are asserted against results the REAL
// core produced, so `failed` reading off `status === 'failed'` rather than the legacy
// `'in_progress'` is a fact about the core rather than a restatement of the runner.

describe('sweepRunExitCode — non-zero iff a tenant failed (Req 2.1, 2.2)', () => {
  const runner = loadRunner();

  it.each([0, 1, 2, 3, 6])('%i Tenant_Sweep_Failures', (tenantFailures) => {
    expect(runner.sweepRunExitCode({ tenantFailures })).toBe(tenantFailures > 0 ? 1 : 0);
  });

  /**
   * The predicate reads `tenantFailures` and NOTHING else, which is what keeps an
   * abort green for every one of the five abort reasons alike (Req 2.2). An abort is
   * a designed safe outcome — `tenant_scope_violation` most of all, since it is the
   * Scope_Guard working — and making it red would train an operator to treat a
   * functioning safety guard as an incident.
   */
  it('stays zero for a run of nothing but aborted tenants', () => {
    expect(runner.sweepRunExitCode({ tenantFailures: 0 })).toBe(0);
  });

  it('is a biconditional: zero exactly when the failure count is zero', () => {
    for (let count = 0; count <= 12; count += 1) {
      const exitCode = runner.sweepRunExitCode({ tenantFailures: count });
      expect(exitCode === 0).toBe(count === 0);
      expect(exitCode === 1).toBe(count > 0);
    }
  });

  /**
   * Additive (spec task 9.3). The SECOND exit-code input, Req 5.9: a run whose
   * Run_Lease was lost to a foreign Lease_Token started no further tenant, so it is
   * red for the same reason a Tenant_Sweep_Failure is — we were asked to sweep and
   * did not.
   *
   * Note the two lease outcomes that never reach this function at all, which is what
   * keeps Req 5.21's pair distinct: a DECLINED acquisition returns from `main()`
   * before the core is entered, so there is no run result to score and the exit
   * status is left as found (zero); a FAILED acquisition throws and reaches
   * `main().catch` (non-zero). Only a lost lease is scored here.
   */
  it('is red for a lost Run_Lease even with no tenant failure (Req 5.9)', () => {
    expect(runner.sweepRunExitCode({ tenantFailures: 0, leaseLost: true })).toBe(1);
    expect(runner.sweepRunExitCode({ tenantFailures: 3, leaseLost: true })).toBe(1);
  });

  it('stays green for a run that held its lease throughout', () => {
    expect(runner.sweepRunExitCode({ tenantFailures: 0, leaseLost: false })).toBe(0);
  });

  /**
   * The disjunction, over both inputs at once — and the `=== true` in the
   * implementation is what makes the third row meaningful: an ABSENT `leaseLost`,
   * which is what a caller predating the lease passes, must read as "not lost" rather
   * than as anything truthy-adjacent.
   */
  it('is zero exactly when neither input is set', () => {
    for (const tenantFailures of [0, 1, 5]) {
      for (const leaseLost of [true, false, undefined]) {
        const exitCode = runner.sweepRunExitCode({ tenantFailures, leaseLost });
        expect(exitCode === 0).toBe(tenantFailures === 0 && leaseLost !== true);
      }
    }
  });
});

describe('the run summary counts (Req 2.4)', () => {
  const runner = loadRunner();
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;
  let exitCodeAtStart: typeof process.exitCode;

  beforeAll(() => {
    exitCodeAtStart = process.exitCode;
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterAll(() => {
    consoleLogSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    // Neither the core nor the exit-code seam writes `process.exitCode`; a leak
    // would make the whole jest process exit non-zero with every test green.
    const leaked = process.exitCode;
    process.exitCode = exitCodeAtStart;
    expect(leaked).toBe(exitCodeAtStart);
  });

  it('partition a run of one completed, one aborted and one failed tenant', async () => {
    // The REAL core, obtained past this suite's partial mock exactly as the
    // documented-defaults case above does. The mocked entrypoint stays mocked for
    // the runner; this is the implementation the summary's numbers come from.
    const sweep = jest.requireActual(
      '../jobs/storageOrphanSweep'
    ) as typeof import('../jobs/storageOrphanSweep');
    const harness = jest.requireActual(
      './support/storageOrphanSweepHarness'
    ) as typeof import('./support/storageOrphanSweepHarness');

    const nowMs = Date.parse('2026-04-01T00:00:00Z');
    const old = harness.iso(nowMs - 120 * 86_400_000);
    const log = harness.createOperationLog();
    const objects = ['acme', 'beta', 'gamma'].map((tenantId) => ({
      name: `notices/${tenantId}/notice_k_a.png`,
      size: 10,
      timeCreated: old,
      updated: old,
    }));
    const db = harness.createFakeFirestore({
      log,
      collections: {
        // `gamma` alone carries a malformed reference, so it ABORTS rather than
        // failing — the distinction the summary's three counts exist to keep.
        notices: {
          gamma_bad: {
            tenantId: 'gamma',
            imageUrl: `https://firebasestorage.googleapis.com/v0/b/${harness.BUCKET_NAME}/o/%zz`,
          },
        },
      },
    });
    const bucket = harness.createFakeBucket({
      log,
      objects,
      // `beta` alone cannot be listed, so it is a Tenant_Sweep_Failure.
      failGetFiles: (call) =>
        call.maxResults !== undefined && call.prefix?.includes('/beta/') === true
          ? new Error('listing page failed')
          : undefined,
    });

    const result = await sweep.runStorageOrphanSweep({
      db: db as never,
      rtdb: harness.createFakeRtdb({ log, tree: {} }) as never,
      bucket: bucket as never,
      config: harness.sweepConfig({ tenantIds: ['acme', 'beta', 'gamma'], nowMs }) as never,
    });

    // The three counts the runner logs, derived exactly as it derives them.
    const completed = result.tenants.filter((tenant) => tenant.status === 'completed').length;
    const aborted = result.tenants.filter((tenant) => tenant.status === 'aborted').length;
    const failed = result.tenantFailures;

    expect(completed).toBe(1);
    expect(aborted).toBe(1);
    expect(failed).toBe(1);
    // They PARTITION the run: a summary that under-counted would leave a tenant
    // whose outcome an operator never sees.
    expect(completed + aborted + failed).toBe(result.tenants.length);

    // `failed` reads off `status === 'failed'`, so the number in the log and the
    // number driving the exit code are the same one (Req 1.11).
    expect(result.tenants.filter((tenant) => tenant.status === 'failed').length).toBe(failed);
    // And the legacy value appears on no result at all: after the confinement the
    // core returns `'in_progress'` for no tenant, which is why the runner's
    // per-failure predicate is `status === 'failed'` rather than an inequality.
    expect(result.tenants.filter((tenant) => tenant.status === 'in_progress')).toEqual([]);

    expect(runner.sweepRunExitCode(result)).toBe(1);
  });
});

// ─── The reference-ceiling heap refusal (storage-sweep-scale-hardening 8.7) ────
//
// Additive: nothing above is edited. Req 8.6's refusal is the third and newest of the
// runner's three, and it is the one that converts an exit-137 container kill — no
// Report_Document, no explanation — into a start-up error naming the four numbers
// involved.
//
// ── How "before `initFirebase`" is asserted, given that `main()` is unreachable ──
//
// `main()` is invoked only under `require.main === module` and is not exported, which
// the suite above asserts rather than assumes. So the claim decomposes into two halves,
// and both are checked:
//
//  1. the refusal is produced by a PURE function that touches no Firebase — asserted
//     through the same `sideEffects` recorder every case above uses;
//  2. `main()` throws on a `refuse` decision BEFORE it calls `initFirebase()` — an
//     ordering fact about the source, asserted over the source, because the only other
//     way to observe it would be to spawn a process.
//
// The same reasoning applies to Req 8.14's start-up line: the line itself is
// unobservable here, so what is asserted is that every number it carries comes from an
// exported seam and equals what that seam produces.

describe('decideStartup — the reference ceiling must fit the observed heap (Req 8.6)', () => {
  const runner = loadRunner();

  /** A heap limit that comfortably holds the documented default ceiling. */
  const ROOMY_HEAP_BYTES = 896 * 1024 * 1024;

  it('refuses a ceiling whose retain set cannot fit, naming all four numbers', () => {
    // The configuration this refusal exists for, and the one that shipped: the OLD
    // default of 2,000,000 references against a `512Mi` container with a declared
    // ~400 MB old-space limit. The estimate is ≈ 464 MB against a 280 MB guard, so the
    // documented `reference_cap_exceeded` abort could not fire — the container was
    // killed first.
    const config = runner.loadRunnerConfig(
      enabledEnv({ STORAGE_ORPHAN_SWEEP_MAX_REFERENCES: '2000000' })
    );
    const heapLimitBytes = 400 * 1024 * 1024;
    const decision = runner.decideStartup(config, heapLimitBytes);

    expect(decision.action).toBe('refuse');
    if (decision.action !== 'refuse') throw new Error('unreachable');
    expect(decision.reason).toBe('reference_ceiling_exceeds_heap');

    // Req 8.14's content, on the refusal path: the ceiling is what an operator can
    // lower, the estimate is what it costs, the guard is what it had to fit inside, and
    // the OBSERVED limit is how they find out whether NODE_OPTIONS reached the process.
    const estimateBytes = estimateRetainSetFootprintBytes(2_000_000);
    const guardBytes = heapGuardBytes(heapLimitBytes);
    expect(decision.message).toContain('2000000');
    expect(decision.message).toContain(String(estimateBytes));
    expect(decision.message).toContain(String(guardBytes));
    expect(decision.message).toContain(String(heapLimitBytes));
    expect(decision.message).toMatch(/refusing to start/i);
    // The two remedies, both of them, because raising only the container limit does
    // nothing: the comparison is against what V8 believes it may use.
    expect(decision.message).toContain('STORAGE_ORPHAN_SWEEP_MAX_REFERENCES');
    expect(decision.message).toContain('--max-old-space-size');
  });

  it('runs at the documented default ceiling against the declared old-space limit', () => {
    // The pairing both Cloud Run Job definitions now declare: 500,000 references
    // against `--max-old-space-size=896` under a `1Gi` container. ≈ 116 MB against a
    // 627 MB guard — real headroom, and the abort is reachable.
    const config = runner.loadRunnerConfig(enabledEnv());
    const decision = runner.decideStartup(config, ROOMY_HEAP_BYTES);
    expect(decision.action).toBe('run');
    expect(estimateRetainSetFootprintBytes(config.maxReferences)).toBeLessThan(
      DEFAULT_HEAP_GUARD_FRACTION * ROOMY_HEAP_BYTES
    );
  });

  /**
   * An unreadable limit REFUSES rather than proceeds, and the direction is the point: a
   * limit we cannot read is a limit we cannot check against, and the failure this gate
   * exists to prevent is precisely the one that looks like a successful start.
   */
  it.each([Number.NaN, 0, -1, Number.POSITIVE_INFINITY])(
    'refuses an unreadable observed heap limit of %p',
    (heapLimitBytes) => {
      const decision = runner.decideStartup(runner.loadRunnerConfig(enabledEnv()), heapLimitBytes);
      expect(decision.action).toBe('refuse');
      if (decision.action !== 'refuse') throw new Error('unreachable');
      expect(decision.reason).toBe('reference_ceiling_exceeds_heap');
      expect(decision.message).toMatch(/unreadable/i);
    }
  );

  /**
   * The new check is APPENDED after the two existing refusals, so neither of their
   * messages nor their relative order changes (Req 11.2) — and `enabled` stays first,
   * because a disabled job must do nothing rather than fail on a ceiling it will never
   * use.
   */
  it('keeps the enable check and the two existing refusals ahead of it', () => {
    // Disabled and misconfigured every way at once, including an impossible ceiling:
    // still a skip.
    const disabled = runner.decideStartup(
      runner.loadRunnerConfig(env({ STORAGE_ORPHAN_SWEEP_MAX_REFERENCES: '2000000' })),
      1
    );
    expect(disabled.action).toBe('skip');

    // A missing database url outranks the ceiling: its message is unchanged.
    const noDatabase = runner.decideStartup(
      runner.loadRunnerConfig(
        enabledEnv({
          FIREBASE_DATABASE_URL: undefined,
          STORAGE_ORPHAN_SWEEP_MAX_REFERENCES: '2000000',
        })
      ),
      1
    );
    expect(noDatabase.action).toBe('refuse');
    if (noDatabase.action !== 'refuse') throw new Error('unreachable');
    expect(noDatabase.reason).toBe('missing_database_url');

    const noBucket = runner.decideStartup(
      runner.loadRunnerConfig(
        enabledEnv({
          FIREBASE_STORAGE_BUCKET: '  ',
          STORAGE_ORPHAN_SWEEP_MAX_REFERENCES: '2000000',
        })
      ),
      1
    );
    expect(noBucket.action).toBe('refuse');
    if (noBucket.action !== 'refuse') throw new Error('unreachable');
    expect(noBucket.reason).toBe('missing_storage_bucket');
  });

  /**
   * Omitting the reading means "no reading was taken", which is a different fact from
   * "the limit is unreadable" — and the decision is then exactly the shipped one. This
   * is what keeps the parameter additive: every existing caller and every existing case
   * above passes one argument and is unaffected.
   */
  it('leaves the decision exactly as shipped when no reading is supplied', () => {
    const config = runner.loadRunnerConfig(
      enabledEnv({ STORAGE_ORPHAN_SWEEP_MAX_REFERENCES: '2000000' })
    );
    expect(runner.decideStartup(config)).toEqual({
      action: 'run',
      mode: 'report',
      apply: false,
      purgeEnabled: false,
    });
  });

  it('reaches the refusal without initialising Firebase (Req 8.6)', () => {
    const before = { ...sideEffects };

    // Every branch of the gate, the new one included, driven end to end.
    for (const [overrides, heapLimitBytes] of [
      [env(), 1],
      [enabledEnv({ FIREBASE_DATABASE_URL: undefined }), ROOMY_HEAP_BYTES],
      [enabledEnv({ FIREBASE_STORAGE_BUCKET: undefined }), ROOMY_HEAP_BYTES],
      [enabledEnv({ STORAGE_ORPHAN_SWEEP_MAX_REFERENCES: '2000000' }), 400 * 1024 * 1024],
      [enabledEnv(), Number.NaN],
      [enabledEnv(), ROOMY_HEAP_BYTES],
    ] as const) {
      runner.decideStartup(runner.loadRunnerConfig(overrides), heapLimitBytes);
    }

    expect(sideEffects.initFirebaseCalls).toBe(before.initFirebaseCalls);
    expect(sideEffects.adminInitializeAppCalls).toBe(before.adminInitializeAppCalls);
    expect(sideEffects.adminFirestoreCalls).toBe(before.adminFirestoreCalls);
    expect(sideEffects.adminDatabaseCalls).toBe(before.adminDatabaseCalls);
    expect(sideEffects.adminStorageCalls).toBe(before.adminStorageCalls);
    expect(sideEffects.sweepCoreCalls).toBe(before.sweepCoreCalls);
    expect(sideEffects.purgeCalls).toBe(before.purgeCalls);
  });

  /**
   * The other half of "before `initFirebase`": `main()` throws on a `refuse` decision
   * before it initialises anything. `main` is unexported and reachable only under
   * `require.main === module`, so the ordering is asserted over the source rather than
   * by spawning a process — and the heap READING is taken before the gate, which is
   * what makes the refusal reachable at all.
   */
  it('throws on a refusal before it calls initFirebase, and reads the heap before the gate', () => {
    const source = readFileSync(resolve(__dirname, '../jobs/runStorageOrphanSweep.ts'), 'utf8');
    const body = source.slice(source.indexOf('async function main()'));

    const readsHeap = body.indexOf('readHeapLimitBytes()');
    const decides = body.indexOf('decideStartup(config, heapLimitBytes)');
    const throwsOnRefusal = body.indexOf('throw new Error(decision.message)');
    const initialises = body.indexOf('initFirebase();');

    for (const index of [readsHeap, decides, throwsOnRefusal, initialises]) {
      expect(index).toBeGreaterThan(-1);
    }
    expect(readsHeap).toBeLessThan(decides);
    expect(decides).toBeLessThan(throwsOnRefusal);
    expect(throwsOnRefusal).toBeLessThan(initialises);
  });
});

describe('the start-up line reports the ceiling, its cost and the OBSERVED limit (Req 8.14)', () => {
  const runner = loadRunner();

  /**
   * The line itself is emitted inside `main()` and is therefore unobservable here by
   * design — the same constraint the run-summary block above records. What is
   * assertable, and what the line is only as good as, are the three values it reads:
   * the resolved ceiling, the footprint estimate for it, and the reading
   * `readHeapLimitBytes()` produced. All three come from exported seams.
   */
  it('derives all three numbers from exported seams at the documented default', () => {
    const config = runner.loadRunnerConfig(enabledEnv());
    expect(config.maxReferences).toBe(DOCUMENTED_DEFAULTS.STORAGE_ORPHAN_SWEEP_MAX_REFERENCES);

    const estimateBytes = estimateRetainSetFootprintBytes(config.maxReferences);
    // ≈ 116 MB at 232 bytes per retained path. Pinned as a range rather than a literal
    // so a deliberate change to a per-path term is not a failure here as well as in
    // `sweepScaleLimits.test.ts`, which owns that arithmetic.
    expect(estimateBytes).toBeGreaterThan(100 * 1024 * 1024);
    expect(estimateBytes).toBeLessThan(130 * 1024 * 1024);

    const heapLimitBytes = runner.readHeapLimitBytes();
    expect(Number.isFinite(heapLimitBytes)).toBe(true);
    expect(heapLimitBytes).toBeGreaterThan(0);
  });

  /**
   * `readHeapLimitBytes` reports what **V8 believes** it may use, which is the whole
   * operator value of logging it: with no `--max-old-space-size`, V8 derives that from
   * SYSTEM memory — the host's on Cloud Run, not the cgroup's — so a limit near 2 GB
   * logged by a `1Gi` container means the declaration never reached the process.
   */
  it('reports exactly what V8 reports', () => {
    expect(runner.readHeapLimitBytes()).toBe(v8.getHeapStatistics().heap_size_limit);
  });
});

/**
 * Additive (spec task 9.2). The Run_Lease wiring inside `main()`.
 *
 * ── Why these are asserted over the SOURCE, and when that is legitimate ────────
 *
 * `main()` is unexported and reachable only under `require.main === module`, which
 * this suite asserts rather than assumes. So a claim about what `main()` does
 * *before* something else has no runtime observable here, and the precedent this
 * follows is the refusal-ordering case above, landed by task 8.7 for exactly the
 * same constraint.
 *
 * What that buys and what it does not: these assertions pin the ORDER and the
 * PRESENCE of the lease calls, which is all Reqs 5.1, 5.4 and 5.20 are about at this
 * layer. They say nothing about what `acquireRunLease` does — that is the lease
 * module's own contract, tested against a Firestore fake in wave 19 (spec tasks 9.4
 * and 9.6), where a real run is driven and "no `getFiles` on a decline" becomes a
 * count in the operation log rather than a fact about text.
 */
describe('the Run_Lease is wired into main() in the required order (Reqs 5.1, 5.4, 5.20)', () => {
  const source = readFileSync(resolve(__dirname, '../jobs/runStorageOrphanSweep.ts'), 'utf8');
  const body = source.slice(source.indexOf('async function main()'));

  /**
   * Drop whole-line `//` comments.
   *
   * Required rather than tidy: every claim below is about CODE, and this file's
   * comments discuss the very identifiers being searched for — the decline branch's
   * own comment says `process.exitCode` is left untouched, which a naive substring
   * search reads as an assignment. Whole-line only, and deliberately not a general
   * comment stripper, so a `//` inside a string literal is left alone.
   */
  const code = (text: string): string =>
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

  const initialises = body.indexOf('initFirebase();');
  const acquires = body.indexOf('await acquireRunLease({');
  const declineGuard = body.indexOf('if (!lease.ok) {');
  const declineReturn = body.indexOf('return;', declineGuard);
  const entersCore = body.indexOf('await runStorageOrphanSweep({');
  const purges = body.indexOf('await purgeExpiredQuarantine({');
  const releases = body.indexOf('await lease.handle.release()');

  it('every call site exists', () => {
    for (const index of [
      initialises,
      acquires,
      declineGuard,
      declineReturn,
      entersCore,
      purges,
      releases,
    ]) {
      expect(index).toBeGreaterThan(-1);
    }
  });

  /**
   * Req 5.1: acquired after `initFirebase()` — it needs a Firestore handle — and
   * before the core is entered, which is before the Reference_Collector reads
   * anything for the first tenant.
   */
  it('acquires after initFirebase and before the core is entered', () => {
    expect(initialises).toBeLessThan(acquires);
    expect(acquires).toBeLessThan(entersCore);
  });

  /**
   * Req 5.4 — the whole of "no Object_Listing on a decline", as an ordering: the
   * decline branch `return`s, and its `return` precedes BOTH the core call and the
   * purge stage, so neither is reachable on that path. Nothing else in `main()`
   * lists.
   *
   * And it is a plain `return` rather than a `throw`, which is the green half of
   * Req 5.21: `process.exitCode` is assigned nowhere on this path, so a declined run
   * leaves the process exit status exactly as it found it.
   */
  it('returns from the decline branch before the core and before the purge stage', () => {
    expect(declineGuard).toBeLessThan(declineReturn);
    expect(declineReturn).toBeLessThan(entersCore);
    expect(declineReturn).toBeLessThan(purges);

    const declineBranch = code(body.slice(declineGuard, declineReturn));
    expect(declineBranch).toContain("outcome: 'contended'");
    // No exit code is touched, and nothing is thrown, on the declined path.
    expect(declineBranch).not.toContain('process.exitCode');
    expect(declineBranch).not.toContain('throw');
  });

  /**
   * Req 5.20, 5.22 — the FAILED acquisition. There is no `try` between
   * `initFirebase()` and the acquisition, so a thrown transaction propagates to
   * `main().catch`, which sets a non-zero exit code with nothing listed and no tenant
   * swept. A `try` here that fell back to sweeping leaseless would reintroduce the
   * overlap the lease exists to prevent, at the moment Firestore is least healthy.
   */
  it('leaves an acquisition failure to propagate rather than catching it', () => {
    const preamble = body.slice(initialises, acquires);
    // The one `try` in this window is the Realtime Database handle's, which predates
    // the lease and catches only `admin.database()`.
    expect(preamble.match(/\btry\s*\{/g) ?? []).toHaveLength(1);
    expect(preamble).toContain('rtdb = admin.database();');

    // And the acquisition itself is not inside a `try` of its own: the statement that
    // opens the lease-held region comes AFTER it.
    const leaseTry = body.indexOf('try {', acquires);
    expect(leaseTry).toBeGreaterThan(acquires);
    expect(leaseTry).toBeLessThan(entersCore);
  });

  /**
   * Req 5.6: released on completion and on failure alike, which is what a `finally`
   * is. The purge stage sits inside the same `try`, so Req 2.5's "a partially failed
   * run still purges" and Req 5.6 do not compete.
   */
  it('releases in a finally that also encloses the purge stage', () => {
    expect(entersCore).toBeLessThan(purges);
    expect(purges).toBeLessThan(releases);
    expect(body.indexOf('} finally {', purges)).toBeLessThan(releases);
  });

  /**
   * Req 5.17: the Lease_Token and the Lease_Expiry are logged during start-up, before
   * the core is entered. They cannot ride on the `starting job` line, which is emitted
   * before `initFirebase()` and therefore before either value exists — so they get
   * their own line, still ahead of every read.
   *
   * Logging the token is safe because it is a fence rather than a credential: holding
   * it grants no access to anything, only the right to renew or release this lease.
   */
  it('logs the token and the expiry before entering the core', () => {
    const leaseLine = body.indexOf("log('run lease acquired'");
    expect(leaseLine).toBeGreaterThan(acquires);
    expect(leaseLine).toBeLessThan(entersCore);

    const fields = body.slice(leaseLine, body.indexOf('});', leaseLine));
    expect(fields).toContain('token: lease.handle.token');
    expect(fields).toContain('expiresAtMs: lease.handle.expiresAtMs');
  });

  /**
   * The core's only coupling to the lease is the injected renewal callback (Req 5.8,
   * 5.16). Asserted here because the alternative — passing a handle, or importing the
   * lease module into the core — is the edit that would break Req 5.16 at the module
   * graph, and it would still pass every behavioural test.
   */
  it('injects only the renewal callback into the core', () => {
    const coreArgs = body.slice(entersCore, body.indexOf('});', entersCore));
    expect(coreArgs).toContain('renewRunLease: () => lease.handle.renew()');
    expect(coreArgs).not.toContain('lease.handle,');
  });

  /**
   * Req 5.16 as a fact about the module graph: the core must never import the lease.
   * The import direction is lease → core and runner → both, so `clampRunLeaseMs` is
   * applied in the runner and its result is echoed down through `SweepConfig`.
   */
  it('keeps the import direction lease → core', () => {
    // Matched against the module SPECIFIER, not against the file's prose: the core
    // discusses `jobs/storageOrphanSweepLease.ts` in several comments, which is the
    // point — it explains why it does not import it.
    const importsLease = /(?:from|require\()\s*['"][^'"]*storageOrphanSweepLease['"]/;

    const core = readFileSync(resolve(__dirname, '../jobs/storageOrphanSweep.ts'), 'utf8');
    expect(importsLease.test(core)).toBe(false);

    const lease = readFileSync(resolve(__dirname, '../jobs/storageOrphanSweepLease.ts'), 'utf8');
    expect(lease).toContain("from './storageOrphanSweep'");

    // And the runner imports both, which is what makes it the only layer that knows
    // about the lease at all.
    expect(importsLease.test(source)).toBe(true);
    expect(source).toContain("from './storageOrphanSweep'");
  });
});

/**
 * Additive (spec task 9.6). Req 5.17 — the Lease_Token and the Lease_Expiry in the
 * run's start-up log line.
 *
 * ── Req 5.17 says "line", singular, and NOTHING can satisfy that reading ────────
 *
 * The shipped `starting job` line is the obvious candidate and it cannot carry
 * either value: it is emitted **before** `initFirebase()`, so that the reference
 * ceiling refusal of Req 8.6 fires with nothing initialised, while both values are
 * produced by an acquisition that needs a Firestore handle and therefore comes
 * after it. `design.md`'s own runner pseudocode resolves this the same way, so what
 * landed is **two** start-up lines: `starting job` gained the resolved `leaseMs`, the
 * `leasePath` and the `sweepId`, and a separate `run lease acquired` carries the
 * token, the expiry and its ISO form. Both precede every read, so Req 5.17 holds in
 * substance; only its one-line reading does not.
 *
 * These cases therefore assert **what exists**: two lines, in that order, with the
 * token on the second one and provably not on the first. A single-line reading
 * asserted here would be a test that could only pass by breaking Req 8.6.
 */
describe('Req 5.17 is satisfied by TWO start-up lines, not one', () => {
  const source = readFileSync(resolve(__dirname, '../jobs/runStorageOrphanSweep.ts'), 'utf8');
  const body = source.slice(source.indexOf('async function main()'));

  /**
   * Drop whole-line `//` comments before matching, for the reason the lease-wiring
   * block above records: this file's comments discuss the very identifiers being
   * searched for — the `starting job` block's own comment explains why the token
   * cannot ride on it, and names the token while doing so.
   */
  const code = (text: string): string =>
    text
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

  const startingJob = body.indexOf("log('starting job'");
  const initialises = body.indexOf('initFirebase();');
  const acquires = body.indexOf('await acquireRunLease({');
  const leaseAcquired = body.indexOf("log('run lease acquired'");
  const entersCore = body.indexOf('await runStorageOrphanSweep({');

  it('emits both lines, in order, entirely ahead of the core', () => {
    for (const index of [startingJob, initialises, acquires, leaseAcquired, entersCore]) {
      expect(index).toBeGreaterThan(-1);
    }
    // `starting job` is FIRST and precedes `initFirebase()`, which is what makes the
    // Req 8.6 refusal reachable with nothing initialised — and simultaneously what
    // makes it incapable of carrying the token.
    expect(startingJob).toBeLessThan(initialises);
    expect(initialises).toBeLessThan(acquires);
    expect(acquires).toBeLessThan(leaseAcquired);
    expect(leaseAcquired).toBeLessThan(entersCore);
  });

  it('puts the resolved duration, the lease path and the sweep id on the first line', () => {
    const fields = code(body.slice(startingJob, body.indexOf('});', startingJob)));
    expect(fields).toContain('leaseMs,');
    expect(fields).toContain('leasePath: runLeasePath()');
    expect(fields).toContain('sweepId,');
    // And NOT the two values it cannot have: no token, no expiry.
    expect(fields).not.toContain('token');
    expect(fields).not.toContain('expiresAt');
  });

  it('puts the token, the expiry and its ISO form on the second line', () => {
    const fields = code(body.slice(leaseAcquired, body.indexOf('});', leaseAcquired)));
    expect(fields).toContain('token: lease.handle.token');
    expect(fields).toContain('expiresAtMs: lease.handle.expiresAtMs');
    expect(fields).toContain('expiresAtIso: new Date(lease.handle.expiresAtMs).toISOString()');
    // The same lease document the first line named, so the two lines are joinable.
    expect(fields).toContain('leasePath: runLeasePath()');
  });

  /**
   * The number on both lines is the CLAMPED one, resolved exactly once through the
   * lease module's own rule — so the duration an operator reads is the duration in
   * force, and no layer restates the `[5 min, 6 h]` bound.
   */
  it('resolves the duration once, through clampRunLeaseMs, before either line', () => {
    const clamps = code(body).indexOf('const leaseMs = clampRunLeaseMs(config.leaseMs)');
    expect(clamps).toBeGreaterThan(-1);
    expect(clamps).toBeLessThan(code(body).indexOf("log('starting job'"));
    // Applied in exactly one place: `main()` clamps, and the value travels.
    expect(code(body).match(/clampRunLeaseMs\(/g) ?? []).toHaveLength(1);
    // The same resolved number reaches the acquisition and the core's config — the
    // latter built between the acquisition and the core call, so the config literal
    // is where to look rather than the call's own argument list.
    const acquireArgs = body.slice(acquires, body.indexOf('});', acquires));
    expect(acquireArgs).toContain('leaseMs,');
    const buildsConfig = body.indexOf('const sweepConfig: SweepConfig = {');
    expect(buildsConfig).toBeGreaterThan(acquires);
    expect(buildsConfig).toBeLessThan(entersCore);
    const coreConfig = code(body.slice(buildsConfig, entersCore));
    expect(coreConfig).toContain('leaseMs,');
    expect(coreConfig).toContain('leaseToken: lease.handle.token');
  });

  /**
   * Logging the token is safe, and this is the assertion that says why rather than
   * leaving it to prose: the token is a **fence, not a credential**. Holding it
   * grants no access to anything — it only identifies which execution may renew or
   * release this lease, an authority anyone able to read this log already has over
   * the Maintenance_Namespace.
   */
  it('logs no credential alongside it', () => {
    const fields = code(body.slice(leaseAcquired, body.indexOf('});', leaseAcquired)));
    for (const forbidden of ['password', 'secret', 'apiKey', 'credential']) {
      expect(fields.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});
