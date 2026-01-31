#!/usr/bin/env node
/*
 * Removes HTML comments and CSS comments inside inline <style> blocks
 * from exported web HTML (default: dist).
 */
import fs from 'fs';
import path from 'path';

const buildDir = process.argv[2] || 'dist';

if (!fs.existsSync(buildDir)) {
  console.error('[strip-html-comments] build directory not found:', buildDir);
  process.exit(1);
}

const htmlFiles = [];
function walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const f of fs.readdirSync(p)) walk(path.join(p, f));
  } else if (p.endsWith('.html')) {
    htmlFiles.push(p);
  }
}
walk(buildDir);

function stripCssComments(cssText) {
  return cssText.replace(/\/\*[\s\S]*?\*\//g, '');
}

for (const file of htmlFiles) {
  const html = fs.readFileSync(file, 'utf8');

  // Remove HTML comments
  let next = html.replace(/<!--([\s\S]*?)-->/g, '');

  // Remove CSS comments inside inline <style> tags
  next = next.replace(/<style(\s[^>]*)?>([\s\S]*?)<\/style>/gi, (match, attrs = '', css = '') => {
    const cleaned = stripCssComments(css);
    return `<style${attrs}>${cleaned}</style>`;
  });

  if (next !== html) {
    fs.writeFileSync(file, next, 'utf8');
  }
}

console.log('[strip-html-comments] processed', htmlFiles.length, 'HTML file(s)');
