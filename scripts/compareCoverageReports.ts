#!/usr/bin/env ts-node
import fs from 'node:fs';
import path from 'node:path';

interface CoverageSummary {
  collection: string;
  scanned: number;
  populated: number;
  missing: number;
  nullish: number;
  uniqueTenantIds: number;
  sampleTenants?: string[];
  errors?: number;
}

interface CoverageReport {
  generatedAt?: string;
  field?: string;
  summaries: CoverageSummary[];
}

interface DiffRow {
  collection: string;
  scannedBefore: number;
  scannedAfter: number;
  missingBefore: number;
  missingAfter: number;
  missingDelta: number;
  populatedBefore: number;
  populatedAfter: number;
  populatedDelta: number;
  uniqueBefore: number;
  uniqueAfter: number;
  uniqueDelta: number;
  status: 'improved' | 'regressed' | 'unchanged';
  notes?: string;
}

interface TotalsSummary {
  collectionsCompared: number;
  missingBefore: number;
  missingAfter: number;
  missingDelta: number;
  improved: number;
  regressed: number;
  unchanged: number;
}

function usage(): void {
  console.log('Usage: ts-node scripts/compareCoverageReports.ts <before.json> <after.json> [--output diff.json]');
}

function resolveFilePath(inputPath: string): string {
  if (!inputPath) {
    throw new Error('Missing file path');
  }
  if (inputPath.startsWith('.')) {
    return path.resolve(process.cwd(), inputPath);
  }
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(process.cwd(), inputPath);
}

function loadReport(filePath: string): CoverageReport {
  const resolved = resolveFilePath(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Report not found at ${resolved}`);
  }
  const content = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(content) as CoverageReport;
  if (!parsed || !Array.isArray(parsed.summaries)) {
    throw new Error(`Invalid coverage report format: ${resolved}`);
  }
  return parsed;
}

function buildSummaryMap(report: CoverageReport): Map<string, CoverageSummary> {
  const map = new Map<string, CoverageSummary>();
  for (const summary of report.summaries) {
    map.set(summary.collection, summary);
  }
  return map;
}

function padSummary(summary?: CoverageSummary): CoverageSummary {
  return summary ?? {
    collection: 'unknown',
    scanned: 0,
    populated: 0,
    missing: 0,
    nullish: 0,
    uniqueTenantIds: 0,
    sampleTenants: [],
    errors: 0,
  };
}

function describeSampleChanges(before?: CoverageSummary, after?: CoverageSummary): string | undefined {
  const beforeSamples = new Set((before?.sampleTenants ?? []).map((tenant) => tenant.trim()).filter(Boolean));
  const afterSamples = new Set((after?.sampleTenants ?? []).map((tenant) => tenant.trim()).filter(Boolean));

  const added: string[] = [];
  const removed: string[] = [];

  for (const sample of afterSamples) {
    if (!beforeSamples.has(sample)) {
      added.push(sample);
    }
  }

  for (const sample of beforeSamples) {
    if (!afterSamples.has(sample)) {
      removed.push(sample);
    }
  }

  const notes: string[] = [];
  if (added.length) {
    notes.push(`+tenants:${added.join('|')}`);
  }
  if (removed.length) {
    notes.push(`-tenants:${removed.join('|')}`);
  }

  if ((before?.errors ?? 0) && !(after?.errors ?? 0)) {
    notes.push('errors-cleared');
  } else if (!(before?.errors ?? 0) && (after?.errors ?? 0)) {
    notes.push('errors-added');
  }

  return notes.length ? notes.join(', ') : undefined;
}

function diffReports(before: CoverageReport, after: CoverageReport): { rows: DiffRow[]; totals: TotalsSummary } {
  const beforeMap = buildSummaryMap(before);
  const afterMap = buildSummaryMap(after);
  const collections = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);

  const rows: DiffRow[] = [];
  let improved = 0;
  let regressed = 0;
  let unchanged = 0;
  let totalMissingBefore = 0;
  let totalMissingAfter = 0;

  for (const collection of collections) {
    const beforeSummary = padSummary(beforeMap.get(collection));
    const afterSummary = padSummary(afterMap.get(collection));

    const missingDelta = afterSummary.missing - beforeSummary.missing;
    const populatedDelta = afterSummary.populated - beforeSummary.populated;
    const uniqueDelta = afterSummary.uniqueTenantIds - beforeSummary.uniqueTenantIds;

    let status: DiffRow['status'];
    if (missingDelta < 0) {
      status = 'improved';
      improved += 1;
    } else if (missingDelta > 0) {
      status = 'regressed';
      regressed += 1;
    } else {
      status = 'unchanged';
      unchanged += 1;
    }

    totalMissingBefore += beforeSummary.missing;
    totalMissingAfter += afterSummary.missing;

    rows.push({
      collection,
      scannedBefore: beforeSummary.scanned,
      scannedAfter: afterSummary.scanned,
      missingBefore: beforeSummary.missing,
      missingAfter: afterSummary.missing,
      missingDelta,
      populatedBefore: beforeSummary.populated,
      populatedAfter: afterSummary.populated,
      populatedDelta,
      uniqueBefore: beforeSummary.uniqueTenantIds,
      uniqueAfter: afterSummary.uniqueTenantIds,
      uniqueDelta,
      status,
      notes: describeSampleChanges(beforeSummary, afterSummary),
    });
  }

  rows.sort((a, b) => a.collection.localeCompare(b.collection));

  const totals: TotalsSummary = {
    collectionsCompared: rows.length,
    missingBefore: totalMissingBefore,
    missingAfter: totalMissingAfter,
    missingDelta: totalMissingAfter - totalMissingBefore,
    improved,
    regressed,
    unchanged,
  };

  return { rows, totals };
}

function main(): void {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let outputPath: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--output' || arg === '-o') {
      outputPath = argv[i + 1];
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  if (positional.length < 2) {
    usage();
    process.exitCode = 1;
    return;
  }

  const beforePath = positional[0];
  const afterPath = positional[1];

  try {
    const beforeReport = loadReport(beforePath);
    const afterReport = loadReport(afterPath);
    const { rows, totals } = diffReports(beforeReport, afterReport);

    console.log('[coverage-diff] Totals');
    console.table([
      {
        collections: totals.collectionsCompared,
        missingBefore: totals.missingBefore,
        missingAfter: totals.missingAfter,
        missingDelta: totals.missingDelta,
        improved: totals.improved,
        regressed: totals.regressed,
        unchanged: totals.unchanged,
      },
    ]);

    console.log('\n[coverage-diff] Per Collection');
    console.table(
      rows.map((row) => ({
        collection: row.collection,
        missingBefore: row.missingBefore,
        missingAfter: row.missingAfter,
        missingDelta: row.missingDelta,
        populatedBefore: row.populatedBefore,
        populatedAfter: row.populatedAfter,
        populatedDelta: row.populatedDelta,
        uniqueBefore: row.uniqueBefore,
        uniqueAfter: row.uniqueAfter,
        uniqueDelta: row.uniqueDelta,
        status: row.status,
        notes: row.notes ?? '',
      }))
    );

    if (outputPath) {
      const resolvedOutput = resolveFilePath(outputPath);
      const payload = {
        generatedAt: new Date().toISOString(),
        beforeReport: {
          path: resolveFilePath(beforePath),
          generatedAt: beforeReport.generatedAt,
          field: beforeReport.field,
        },
        afterReport: {
          path: resolveFilePath(afterPath),
          generatedAt: afterReport.generatedAt,
          field: afterReport.field,
        },
        totals,
        rows,
      };
      fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
      fs.writeFileSync(resolvedOutput, JSON.stringify(payload, null, 2));
      console.log(`\n[coverage-diff] wrote diff JSON to ${resolvedOutput}`);
    }
  } catch (error) {
    console.error('[coverage-diff] failed:', (error as Error).message);
    process.exitCode = 1;
  }
}

main();
