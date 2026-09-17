/**
 * The two Cloud Run Job definitions, asserted against the constants the runner
 * actually resolves (storage-sweep-scale-hardening task 8.4).
 *
 * ── Why this file exists at all, when Requirement 11 never asks for it ────────
 *
 * The bug task 8 repairs **is** manifest drift. The shipped
 * `storage-orphan-sweep-job.yaml` stated that
 * `STORAGE_ORPHAN_SWEEP_MAX_REFERENCES` "aborts the tenant rather than letting the
 * set outgrow it" — and at the shipped default of 2,000,000 against a `512Mi`
 * container that was **false**: the retain set was estimated at ≈ 464 MB, the
 * container was killed with exit 137 long before the documented
 * `reference_cap_exceeded` abort could fire, and the tenant got no Report_Document
 * and no explanation. No test read either manifest, so nothing could have caught
 * it.
 *
 * Reqs 8.15, 9.11 and 5.10 are therefore *aspirational* without a test that reads
 * the deployed files: each is a statement that a number in YAML agrees with a
 * number in TypeScript, and agreement between two files is exactly what drifts.
 *
 * ── Read with `readFileSync` and a line regex, and no YAML parser ─────────────
 *
 * A handful of scalar lookups against a file whose shape is fixed and reviewed.
 * Adding a YAML dependency to assert four numbers would be a runtime dependency
 * added for a test, and this spec adds none.
 *
 * ── The three claims about the write threshold are NOT one claim ──────────────
 *
 * They are kept in separate `it()` blocks because only one of them is true of both
 * files, and collapsing them would assert something false:
 *
 *  - Req 7.25 — the configured `..._QUARANTINE_WRITE_THRESHOLD` **resolves to**
 *    `DEFAULT_QUARANTINE_WRITE_THRESHOLD`, in **both** files, so an operator
 *    reading either definition reads the write cadence in force in both;
 *  - Req 7.19 — that default **equals the per-tenant Quarantine ceiling the DEV
 *    definition's runbook documents for a first cautious apply run**, which is the
 *    reason the default is 25 at all. The dev file is the only one of the two that
 *    documents such a run;
 *  - and the cautious 25 is an **execution-time override**, not a configured value:
 *    both files set `..._MAX_QUARANTINE_PER_TENANT` to `"1000"` (Req 12.7). A test
 *    that read the configured value here would be asserting the wrong number and
 *    would fail.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { DEFAULT_FIRESTORE_PAGE_SIZE, DEFAULT_MAX_REFERENCES } from '../jobs/storageOrphanSweep';
import {
  DEFAULT_QUARANTINE_WRITE_THRESHOLD,
  DEFAULT_REPORT_WRITE_PAGE_INTERVAL,
  DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS,
  decideReferenceCeilingHeadroom,
  estimateRetainSetFootprintBytes,
  resolveQuarantineWriteThreshold,
} from '../lib/sweepScaleLimits';

// backend-runtime/src/__tests__ -> repo root is three levels up.
const MANIFEST_DIR = resolve(__dirname, '../../../infra/cloud-run');
const PROD_PATH = resolve(MANIFEST_DIR, 'storage-orphan-sweep-job.yaml');
const DEV_PATH = resolve(MANIFEST_DIR, 'storage-orphan-sweep-job-dev.yaml');

interface Manifest {
  label: 'prod' | 'dev';
  path: string;
  /** Every line, verbatim, comments included. */
  lines: string[];
  /** Only the lines YAML actually reads: no whole-line comment, no blank line. */
  code: string[];
}

function loadManifest(label: 'prod' | 'dev', path: string): Manifest {
  const lines = readFileSync(path, 'utf8').split('\n');
  return {
    label,
    path,
    lines,
    // WHOLE-LINE comments only. An inline `#` is deliberately not stripped: no
    // value in either file contains one, and a naive inline strip would corrupt a
    // url if one ever did.
    code: lines.filter((line) => line.trim().length > 0 && !line.trim().startsWith('#')),
  };
}

const PROD = loadManifest('prod', PROD_PATH);
const DEV = loadManifest('dev', DEV_PATH);
const BOTH: Manifest[] = [PROD, DEV];

/** `key: value` from the YAML body, unquoted. Throws when absent, never guesses. */
function scalar(manifest: Manifest, key: string): string {
  const pattern = new RegExp(`^\\s*${key}:\\s*(.*)$`);
  for (const line of manifest.code) {
    const match = pattern.exec(line);
    if (match) return unquote(match[1]);
  }
  throw new Error(`${manifest.label} manifest declares no \`${key}:\``);
}

/**
 * The `value:` belonging to an `- name: VAR` entry in the container's `env` list.
 *
 * Resolved by position — the first `value:` after the `- name:` line — because that
 * is how the YAML sequence binds them, and because several of these variable names
 * also appear inside the surrounding comment blocks. Comments are already gone from
 * `code`, so a mention cannot be mistaken for a declaration.
 */
function envValue(manifest: Manifest, name: string): string {
  const nameLine = new RegExp(`^\\s*-\\s*name:\\s*${name}\\s*$`);
  const valueLine = /^\s*value:\s*(.*)$/;
  for (let index = 0; index < manifest.code.length; index += 1) {
    if (!nameLine.test(manifest.code[index])) continue;
    for (let scan = index + 1; scan < manifest.code.length; scan += 1) {
      const match = valueLine.exec(manifest.code[scan]);
      if (match) return unquote(match[1]);
      // A following `- name:` before any `value:` means the variable is declared
      // with no value, which is a manifest bug rather than something to tolerate.
      if (/^\s*-\s*name:/.test(manifest.code[scan])) break;
    }
    throw new Error(`${manifest.label} manifest declares ${name} with no value`);
  }
  throw new Error(`${manifest.label} manifest declares no ${name}`);
}

function unquote(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * The per-tenant Quarantine ceiling a manifest's **runbook prose** documents for a
 * first cautious Apply_Mode run, or `null` where it documents no such run.
 *
 * Read from the COMMENTS on purpose — this is an execution-time
 * `--update-env-vars` override the dev file's header sequence applies, not a
 * configured value — and matched on `=` so the `- name: …` declaration line and the
 * prose mentions of the variable cannot be picked up instead.
 */
function runbookCautiousCeiling(manifest: Manifest): number | null {
  const pattern = /STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT=(\d+)/;
  const found = new Set<number>();
  for (const line of manifest.lines) {
    if (!line.trim().startsWith('#')) continue;
    const match = pattern.exec(line);
    if (match) found.add(Number(match[1]));
  }
  if (found.size === 0) return null;
  if (found.size > 1) {
    throw new Error(
      `${manifest.label} manifest documents ${found.size} different cautious ceilings: ${[...found].join(', ')}`
    );
  }
  return [...found][0];
}

/** `--max-old-space-size=N` in MiB, from `NODE_OPTIONS`. */
function declaredOldSpaceMib(manifest: Manifest): number {
  const match = /--max-old-space-size=(\d+)/.exec(envValue(manifest, 'NODE_OPTIONS'));
  if (!match) {
    throw new Error(`${manifest.label} manifest's NODE_OPTIONS declares no --max-old-space-size`);
  }
  return Number(match[1]);
}

/** `1Gi` / `512Mi` as bytes, so the old-space declaration can be compared against it. */
function memoryLimitBytes(manifest: Manifest): number {
  const raw = scalar(manifest, 'memory');
  const match = /^(\d+)(Gi|Mi)$/.exec(raw);
  if (!match) throw new Error(`${manifest.label} manifest declares an unreadable memory limit: ${raw}`);
  return Number(match[1]) * (match[2] === 'Gi' ? 1024 * 1024 * 1024 : 1024 * 1024);
}

describe('both Cloud Run Job definitions parse as this test expects', () => {
  // A guard on the reader itself: every assertion below is only as good as these
  // lookups, and a silently-failing regex would make the whole file vacuous.
  it('finds a container env list and a resource block in each file', () => {
    for (const manifest of BOTH) {
      expect(manifest.code.length).toBeGreaterThan(40);
      expect(manifest.lines.length).toBeGreaterThan(manifest.code.length);
      expect(envValue(manifest, 'FIREBASE_PROJECT_ID')).toBe('tution-app-6c0c3');
      expect(scalar(manifest, 'memory')).toMatch(/^\d+(Gi|Mi)$/);
    }
  });

  it('throws rather than guessing for a variable neither file declares', () => {
    expect(() => envValue(PROD, 'STORAGE_ORPHAN_SWEEP_NO_SUCH_VARIABLE')).toThrow(/declares no/);
    expect(() => scalar(DEV, 'noSuchKey')).toThrow(/declares no/);
  });
});

describe('the reference ceiling agrees with the runner (Req 8.15, 9.11)', () => {
  it.each(BOTH)('$label sets MAX_REFERENCES to DEFAULT_MAX_REFERENCES', (manifest) => {
    const configured = envValue(manifest, 'STORAGE_ORPHAN_SWEEP_MAX_REFERENCES');
    expect(configured).toBe(String(DEFAULT_MAX_REFERENCES));
    expect(Number(configured)).toBe(DEFAULT_MAX_REFERENCES);
  });

  /**
   * Req 8.15's actual obligation, and the strongest form of it available here:
   * "so the manifest comment describes behaviour that occurs".
   *
   * The manifest's own numbers are fed to the exact predicate the runner's start-up
   * refusal uses. If the configured ceiling did not fit the old-space limit the same
   * file declares, the deployed job would **refuse to start** — which is what the
   * old `512Mi` + 2,000,000 pairing amounted to once the refusal existed, and it is
   * the pairing this test makes impossible to reintroduce silently.
   */
  it.each(BOTH)('$label declares a ceiling that its own heap declaration can hold', (manifest) => {
    const maxReferences = Number(envValue(manifest, 'STORAGE_ORPHAN_SWEEP_MAX_REFERENCES'));
    const heapLimitBytes = declaredOldSpaceMib(manifest) * 1024 * 1024;

    const headroom = decideReferenceCeilingHeadroom({ maxReferences, heapLimitBytes });
    expect(headroom.ok).toBe(true);
    expect(headroom.estimateBytes).toBe(estimateRetainSetFootprintBytes(maxReferences));
    // Real headroom rather than a hair's breadth: the estimate deliberately models
    // only the retain set, so the margin is what covers what it does not model — a
    // page of snapshots per source, the storage client's buffers, the sort's
    // temporaries — and is what the mid-collection guard is the backstop for.
    expect(headroom.estimateBytes * 2).toBeLessThan(headroom.guardBytes);
  });
});

describe('the container memory limit and the declared V8 old-space limit (Req 8.2, 8.3)', () => {
  it.each(BOTH)('$label limits memory to 1Gi', (manifest) => {
    expect(scalar(manifest, 'memory')).toBe('1Gi');
  });

  it.each(BOTH)('$label declares --max-old-space-size explicitly', (manifest) => {
    expect(envValue(manifest, 'NODE_OPTIONS')).toContain('--max-old-space-size');
    expect(declaredOldSpaceMib(manifest)).toBeGreaterThan(0);
  });

  /**
   * The declaration is load-bearing rather than hygiene, and this is the arithmetic
   * that makes it so. `v8.getHeapStatistics().heap_size_limit` reports what V8
   * BELIEVES it may use, and with no `--max-old-space-size` V8 derives that from
   * SYSTEM memory — the host's on Cloud Run, not the cgroup's. So the declared
   * number must sit UNDER the container limit, leaving the non-heap footprint
   * (native allocations, code, stacks, the storage client's buffers) room inside it.
   */
  it.each(BOTH)('$label declares an old-space limit inside its container limit', (manifest) => {
    const declaredBytes = declaredOldSpaceMib(manifest) * 1024 * 1024;
    const containerBytes = memoryLimitBytes(manifest);
    expect(declaredBytes).toBeLessThan(containerBytes);
    // At least 64 MiB left over for everything that is not the V8 heap.
    expect(containerBytes - declaredBytes).toBeGreaterThanOrEqual(64 * 1024 * 1024);
  });
});

describe('the Report_Document write cadence (Req 7.13, 7.19, 7.25)', () => {
  /**
   * Req 7.25, and it holds of **both** files: each configures the threshold so that
   * it RESOLVES to the default, so an operator reading either definition reads the
   * write cadence in force in both.
   *
   * Resolved through the exported `resolveQuarantineWriteThreshold` rather than
   * compared as a string, because "resolves to" is the obligation: a configured
   * `25.9` or `"25"` resolves to 25 and satisfies Req 7.25, while a configured `0.5`
   * also *looks* close and resolves to 25 for the opposite reason — the Req 7.20
   * fallback — which is a manifest saying something it does not mean.
   */
  it.each(BOTH)('$label configures a threshold that resolves to the default', (manifest) => {
    const configured = envValue(manifest, 'STORAGE_ORPHAN_SWEEP_QUARANTINE_WRITE_THRESHOLD');
    expect(resolveQuarantineWriteThreshold(Number(configured))).toBe(
      DEFAULT_QUARANTINE_WRITE_THRESHOLD
    );
    // And it does so by stating the number, not by tripping the fallback: a
    // manifest whose value were `abc` would satisfy the line above for the wrong
    // reason, because an unreadable value also resolves to the default.
    expect(Number(configured)).toBe(DEFAULT_QUARANTINE_WRITE_THRESHOLD);
  });

  it.each(BOTH)('$label configures both write intervals at their defaults', (manifest) => {
    expect(Number(envValue(manifest, 'STORAGE_ORPHAN_SWEEP_REPORT_WRITE_PAGES'))).toBe(
      DEFAULT_REPORT_WRITE_PAGE_INTERVAL
    );
    expect(Number(envValue(manifest, 'STORAGE_ORPHAN_SWEEP_REPORT_WRITE_MS'))).toBe(
      DEFAULT_REPORT_WRITE_TIME_INTERVAL_MS
    );
    expect(Number(envValue(manifest, 'STORAGE_ORPHAN_SWEEP_FIRESTORE_PAGE_SIZE'))).toBe(
      DEFAULT_FIRESTORE_PAGE_SIZE
    );
  });

  /**
   * Req 7.19, and it is asserted against the **dev** file ALONE — a separate `it()`
   * from Req 7.25 above because only that one is true of both files.
   *
   * The default threshold is 25 because 25 is the per-tenant Quarantine ceiling the
   * dev definition's runbook documents for a first cautious Apply_Mode run, so that
   * run writes the Report_Document **once at the end of its moves rather than 25
   * times**. The dev definition is the only one of the two that documents such a
   * run; the production definition describes no cautious first run at all. If the
   * two ever stop matching, the reason for the number evaporates —
   * `sweepScaleLimits.test.ts` asserts the same equality from the constant's side,
   * so neither can drift alone.
   */
  it('the DEV runbook documents a cautious ceiling equal to the default threshold', () => {
    expect(runbookCautiousCeiling(DEV)).toBe(DEFAULT_QUARANTINE_WRITE_THRESHOLD);
  });

  it('and the PROD definition documents no cautious first run, which is why the claim is dev-only', () => {
    expect(runbookCautiousCeiling(PROD)).toBeNull();
  });

  /**
   * The cautious 25 is an **execution-time override**, never a configured value.
   * Both files leave `..._MAX_QUARANTINE_PER_TENANT` at `1000` (Req 12.7), so a
   * reading of the claim above that compared it against the configured ceiling
   * would be asserting the wrong number. Pinned so that misreading fails here.
   */
  it.each(BOTH)('$label leaves the configured per-tenant ceiling at 1000, not at 25', (manifest) => {
    const configured = Number(envValue(manifest, 'STORAGE_ORPHAN_SWEEP_MAX_QUARANTINE_PER_TENANT'));
    expect(configured).toBe(1000);
    expect(configured).not.toBe(DEFAULT_QUARANTINE_WRITE_THRESHOLD);
  });
});

describe('the Run_Lease outlives the platform timeout (Req 5.10)', () => {
  /**
   * A lease that could expire underneath a task the platform is still running would
   * let a second execution start mid-sweep, which is the overlap the lease exists to
   * prevent. So the inequality is strict and is checked in the units the two values
   * are written in: `..._LEASE_MS` in milliseconds, `timeoutSeconds` in seconds.
   */
  it.each(BOTH)('$label sets a lease duration longer than timeoutSeconds', (manifest) => {
    const leaseMs = Number(envValue(manifest, 'STORAGE_ORPHAN_SWEEP_LEASE_MS'));
    const timeoutSeconds = Number(scalar(manifest, 'timeoutSeconds'));
    expect(Number.isFinite(leaseMs)).toBe(true);
    expect(Number.isFinite(timeoutSeconds)).toBe(true);
    expect(leaseMs / 1000).toBeGreaterThan(timeoutSeconds);
  });
});

describe('the blast-radius settings this spec must not change (Req 2.6, 12.8)', () => {
  it.each(BOTH)('$label keeps retries off and the task count at one', (manifest) => {
    // An automatic retry of a partially applied sweep must stay a HUMAN decision:
    // the run has already moved objects and persisted a resume cursor.
    expect(scalar(manifest, 'maxRetries')).toBe('0');
    // Concurrency is what the Run_Lease removes, not something this job adds.
    expect(scalar(manifest, 'taskCount')).toBe('1');
    expect(scalar(manifest, 'parallelism')).toBe('1');
  });

  it.each(BOTH)('$label ships with all three enable switches off', (manifest) => {
    for (const variable of [
      'STORAGE_ORPHAN_SWEEP_ENABLED',
      'STORAGE_ORPHAN_SWEEP_APPLY',
      'STORAGE_ORPHAN_SWEEP_PURGE_ENABLED',
    ]) {
      expect(envValue(manifest, variable)).toBe('0');
    }
  });

  it.each(BOTH)('$label keeps the grace and retention windows unchanged', (manifest) => {
    expect(envValue(manifest, 'STORAGE_ORPHAN_SWEEP_GRACE_DAYS')).toBe('7');
    expect(envValue(manifest, 'STORAGE_ORPHAN_SWEEP_QUARANTINE_RETENTION_DAYS')).toBe('7');
    expect(envValue(manifest, 'STORAGE_ORPHAN_SWEEP_PAGE_SIZE')).toBe('1000');
  });
});

/**
 * The dev manifest's header claims it "differs only in name and runner id — both
 * manifests pin the SAME image digest", and nothing checked that.
 *
 * ── The claim is NARROWED to the lines YAML reads, and the narrowing is real ───
 *
 * The two files' PROSE differs substantially and legitimately: the dev header
 * carries the whole task-12 verification runbook, a paragraph recording that dev
 * and prod share one Firebase project and therefore one bucket, and the note beside
 * `..._MAX_QUARANTINE_PER_TENANT` explaining why the cautious 25 equals the write
 * threshold — none of which belongs in the production definition, which documents no
 * cautious first run (see the Req 7.19 block above, which depends on exactly that
 * asymmetry). So the comparison is over non-comment, non-blank lines: everything
 * the platform actually reads.
 *
 * Asserted as an exact line-index-to-key mapping rather than as a count, so a
 * second divergence cannot hide behind a matching total.
 */
describe('the two definitions differ only in metadata.name and the runner id', () => {
  it('has the same number of YAML lines in both files', () => {
    expect(DEV.code.length).toBe(PROD.code.length);
  });

  it('differs on exactly the two expected lines, and on nothing else', () => {
    const differing: { index: number; prod: string; dev: string }[] = [];
    for (let index = 0; index < PROD.code.length; index += 1) {
      if (PROD.code[index] !== DEV.code[index]) {
        differing.push({ index, prod: PROD.code[index], dev: DEV.code[index] });
      }
    }

    expect(differing.map((entry) => ({ prod: entry.prod.trim(), dev: entry.dev.trim() }))).toEqual([
      { prod: 'name: storage-orphan-sweep-job', dev: 'name: storage-orphan-sweep-job-dev' },
      {
        prod: 'value: cloud-run-storage-orphan-sweep-job',
        dev: 'value: cloud-run-storage-orphan-sweep-job-dev',
      },
    ]);

    // The second differing line is the runner id's, which is only meaningful if it
    // really is the `value:` bound to `..._RUNNER_ID`.
    expect(envValue(PROD, 'STORAGE_ORPHAN_SWEEP_RUNNER_ID')).toBe(
      'cloud-run-storage-orphan-sweep-job'
    );
    expect(envValue(DEV, 'STORAGE_ORPHAN_SWEEP_RUNNER_ID')).toBe(
      'cloud-run-storage-orphan-sweep-job-dev'
    );
  });

  /**
   * The digest is INSIDE the compared region above, so this is a restatement rather
   * than an extra check — and it is worth restating, because the dev header's claim
   * used to read "only in name, image digest and runner id" and the digests are now
   * identical. A digest, never a tag: a bulk tenant-file deleter must run the bytes
   * that were reviewed.
   */
  it('pins the same image digest in both, by digest rather than by tag', () => {
    const prodImage = PROD.code.find((line) => line.trim().startsWith('- image:'));
    const devImage = DEV.code.find((line) => line.trim().startsWith('- image:'));
    expect(prodImage).toBeDefined();
    expect(prodImage).toBe(devImage);
    expect(prodImage).toMatch(/@sha256:[0-9a-f]{64}$/);
  });
});
