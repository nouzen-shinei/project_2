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

import { DEFAULT_GRACE_DAYS, DEFAULT_QUARANTINE_RETENTION_DAYS } from '../lib/orphanDecision';

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
  STORAGE_ORPHAN_SWEEP_MAX_REFERENCES: 2_000_000,
} as const;

/** Config field each numeric variable resolves onto. */
const NUMERIC_FIELDS = {
  STORAGE_ORPHAN_SWEEP_GRACE_DAYS: 'graceDays',
  STORAGE_ORPHAN_SWEEP_QUARANTINE_RETENTION_DAYS: 'quarantineRetentionDays',
  STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT: 'maxQuarantinePerTenant',
  STORAGE_ORPHAN_SWEEP_PAGE_SIZE: 'pageSize',
  STORAGE_ORPHAN_SWEEP_MAX_REFERENCES: 'maxReferences',
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
      })
    );
    expect(config.graceDays).toBe(30);
    expect(config.quarantineRetentionDays).toBe(14);
    expect(config.maxQuarantinePerTenant).toBe(25);
    expect(config.pageSize).toBe(200);
    expect(config.maxReferences).toBe(500);
  });

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
