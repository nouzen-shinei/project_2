#!/usr/bin/env ts-node
/**
 * Bulk migrate console.* calls to logger.* (except console.error / console.warn we keep as logger.error/warn).
 * - Skips files in node_modules, build, coverage, android, ios, backend-runtime (different runtime?) unless opted in.
 * - Creates a .migrate-logs-backup/ copy of each modified file for safety.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const backupRoot = path.join(projectRoot, '.migrate-logs-backup');

const INCLUDE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx']);
const EXCLUDE_DIRS = new Set([
  'node_modules','build','coverage','.migrate-logs-backup','android','ios','backend-runtime','email-backend','dist'
]);

// CLI flags
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const INCLUDE_BACKEND = argv.includes('--include-backend');
if (INCLUDE_BACKEND) {
  EXCLUDE_DIRS.delete('backend-runtime');
  EXCLUDE_DIRS.delete('email-backend');
}

const loggerImportRegex = /import\s+{\s*logger\s*}\s+from\s+['"](?:@\/)?lib\/logger['"];?/;
const anyImportLine = /import[^;]+logger[^;]+from[^;]+logger/;

let changedCount = 0;
let fileCount = 0;
let replacedCalls = 0;

function ensureBackupDir() { if(!fs.existsSync(backupRoot)) fs.mkdirSync(backupRoot, { recursive: true }); }

function walk(dir: string) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(projectRoot, full);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry)) continue;
      walk(full);
      continue;
    }
    const ext = path.extname(entry);
    if (!INCLUDE_EXT.has(ext)) continue;
    migrateFile(full, rel);
  }
}

// Basic heuristic replacements
const CALL_PATTERNS: Array<{ regex: RegExp; replacement: string; countOnly?: boolean; }>= [
  { regex: /console\.log\(/g, replacement: 'logger.debug(' },
  { regex: /console\.debug\(/g, replacement: 'logger.debug(' },
  { regex: /console\.info\(/g, replacement: 'logger.info(' },
  { regex: /console\.warn\(/g, replacement: 'logger.warn(' },
  { regex: /console\.error\(/g, replacement: 'logger.error(' },
  { regex: /console\.trace\(/g, replacement: 'logger.debug(' },
];

function migrateFile(fullPath: string, rel: string) {
  fileCount++;
  let src = fs.readFileSync(fullPath, 'utf8');
  let original = src;

  let needsImport = !loggerImportRegex.test(src) && !anyImportLine.test(src);
  let localReplaced = 0;
  for (const pat of CALL_PATTERNS) {
    if (pat.regex.test(src)) {
      src = src.replace(pat.regex, (m)=>{ localReplaced++; return pat.replacement; });
    }
  }

  if (localReplaced > 0) {
    // Insert import after first import line or at top
    if (needsImport) {
      const importIdx = src.indexOf('\nimport');
      if (importIdx >= 0) {
        // place before first existing import for determinism
        src = src.replace(/^(import[^]*?)/, (segment) => `import { logger } from '@/lib/logger';\n${segment}`);
        if (!src.startsWith('import { logger }')) {
          // fallback: just prepend
          src = `import { logger } from '@/lib/logger';\n${src}`;
        }
      } else {
        src = `import { logger } from '@/lib/logger';\n${src}`;
      }
    }
  }

  if (src !== original) {
    replacedCalls += localReplaced;
    changedCount++;
    if (DRY_RUN) {
      console.log(`[migrate-logs][dry-run] Would update ${rel} (${localReplaced} calls)`);
    } else {
      ensureBackupDir();
      const backupFile = path.join(backupRoot, rel);
      const backupDir = path.dirname(backupFile);
      fs.mkdirSync(backupDir, { recursive: true });
      fs.writeFileSync(backupFile, original, 'utf8');
      fs.writeFileSync(fullPath, src, 'utf8');
      console.log(`[migrate-logs] Updated ${rel} (${localReplaced} calls)`);
    }
  }
}

walk(projectRoot);
console.log(`\n[migrate-logs] Completed${DRY_RUN ? ' (dry-run)' : ''}. Files scanned: ${fileCount}, would modify/modified: ${changedCount}, calls ${DRY_RUN ? 'that would be replaced' : 'replaced'}: ${replacedCalls}.${DRY_RUN ? '' : ' Backups in .migrate-logs-backup/'}\n`);
if (DRY_RUN) {
  console.log('Run without --dry-run to apply changes. Use --include-backend to also migrate backend-runtime & email-backend.');
}
