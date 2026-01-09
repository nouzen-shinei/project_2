#!/usr/bin/env node
/*
 * Scans the exported web build (dist or .expo directory after export) for inline <style> and <script> tags
 * and outputs CSP hash directives you can paste into CSP. Optionally writes a JSON manifest consumed at runtime.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const buildDir = process.argv[2] || 'dist';
const outJson = process.argv[3] || 'csp-hashes.json';

if (!fs.existsSync(buildDir)) {
  console.error('[hashgen] build directory not found:', buildDir);
  process.exit(1);
}

function sha256Base64(content){
  return crypto.createHash('sha256').update(content).digest('base64');
}

const htmlFiles = [];
function walk(p){
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(p)) walk(path.join(p,f));
  } else if (p.endsWith('.html')) htmlFiles.push(p);
}
walk(buildDir);

const styleHashes = new Set();
const scriptHashes = new Set();

for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');
  // Match <style>...</style>
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = styleRe.exec(html))) {
    const content = m[1].trim();
    if (!content) continue;
    const hash = sha256Base64(content);
    styleHashes.add(`'sha256-${hash}'`);
  }
  // Match inline <script> (skip with src=)
  const scriptRe = /<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi;
  let ms;
  while ((ms = scriptRe.exec(html))) {
    const content = ms[1].trim();
    if (!content) continue;
    // ignore empty hydration markers
    if (content.length < 8) continue;
    const hash = sha256Base64(content);
    scriptHashes.add(`'sha256-${hash}'`);
  }
}

const result = {
  generatedAt: new Date().toISOString(),
  style: Array.from(styleHashes).sort(),
  script: Array.from(scriptHashes).sort()
};

fs.writeFileSync(outJson, JSON.stringify(result, null, 2));
console.log('[hashgen] wrote', outJson);
console.log('\n# Add to CSP (replace unsafe-inline):');
if (result.style.length) console.log('style-src', ['\'self\'', ...result.style].join(' '));
if (result.script.length) console.log('script-src', ['\'self\'', ...result.script].join(' '));
