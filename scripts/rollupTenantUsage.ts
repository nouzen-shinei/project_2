#!/usr/bin/env ts-node
import 'dotenv/config';
import type { CliOptions } from '../backend-runtime/src/jobs/tenantUsageRollup';
import { runTenantUsageRollup, shutdownFirebase } from '../backend-runtime/src/jobs/tenantUsageRollup';

const MONTH_ARG_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    tenantId: null,
    month: null,
    backfill: 0,
    dryRun: false,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--tenant':
      case '--tenantId':
        options.tenantId = argv[i + 1];
        i += 1;
        break;
      case '--month':
        options.month = MONTH_ARG_REGEX.test(argv[i + 1] ?? '') ? argv[i + 1] : null;
        i += 1;
        break;
      case '--backfill':
      case '--months':
        options.backfill = Math.max(0, Number(argv[i + 1]) || 0);
        i += 1;
        break;
      case '--dry-run':
      case '--dryrun':
        options.dryRun = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
      default:
        break;
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  try {
    await runTenantUsageRollup(options);
  } finally {
    await shutdownFirebase();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[rollup] fatal error', error);
    process.exitCode = 1;
  });
}
