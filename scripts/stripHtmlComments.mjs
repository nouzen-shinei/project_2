#!/usr/bin/env node
/*
 * Removes HTML comments and CSS comments inside inline <style> blocks
 * from exported web HTML (default: dist).
 */
import fs from 'fs';
import path from 'path';

const buildDir = process.argv[2] || 'dist';

const REQUIRED_HEAD_TAGS = [
  {
    test: /<meta[^>]*name=["']application-name["'][^>]*>/i,
    tag: '<meta name="application-name" content="Tuition Manager" />',
  },
  {
    test: /<meta[^>]*name=["']description["'][^>]*>/i,
    tag: '<meta name="description" content="Complete tuition and coaching class management solution" />',
  },
  {
    test: /<meta[^>]*name=["']theme-color["'][^>]*media=["']\(prefers-color-scheme: light\)["'][^>]*content=["']#ffffff["'][^>]*>/i,
    tag: '<meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />',
  },
  {
    test: /<meta[^>]*name=["']theme-color["'][^>]*media=["']\(prefers-color-scheme: dark\)["'][^>]*content=["']#1e293b["'][^>]*>/i,
    tag: '<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#1e293b" />',
  },
  {
    test: /<meta[^>]*name=["']theme-color["'][^>]*content=["']#1e293b["'][^>]*>/i,
    tag: '<meta name="theme-color" content="#1e293b" />',
  },
  {
    test: /<meta[^>]*name=["']mobile-web-app-capable["'][^>]*>/i,
    tag: '<meta name="mobile-web-app-capable" content="yes" />',
  },
  {
    test: /<meta[^>]*name=["']apple-mobile-web-app-capable["'][^>]*>/i,
    tag: '<meta name="apple-mobile-web-app-capable" content="yes" />',
  },
  {
    test: /<meta[^>]*name=["']apple-mobile-web-app-status-bar-style["'][^>]*>/i,
    tag: '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />',
  },
  {
    test: /<meta[^>]*name=["']apple-mobile-web-app-title["'][^>]*>/i,
    tag: '<meta name="apple-mobile-web-app-title" content="Tuition Manager" />',
  },
  {
    test: /<link[^>]*rel=["']manifest["'][^>]*href=["']\/manifest-r12\.json["'][^>]*>/i,
    tag: '<link rel="manifest" href="/manifest-r12.json" />',
  },
  {
    test: /<link[^>]*rel=["']apple-touch-icon["'][^>]*href=["']\/pwa\/apple-icon-180\.png\?v=20260407r12["'][^>]*>/i,
    tag: '<link rel="apple-touch-icon" sizes="180x180" href="/pwa/apple-icon-180.png?v=20260407r12" />',
  },
  {
    test: /<link[^>]*rel=["']icon["'][^>]*sizes=["']32x32["'][^>]*href=["']\/favicon-32x32\.png\?v=20260407r12["'][^>]*>/i,
    tag: '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png?v=20260407r12" />',
  },
  {
    test: /<link[^>]*rel=["']icon["'][^>]*sizes=["']16x16["'][^>]*href=["']\/favicon-16x16\.png\?v=20260407r12["'][^>]*>/i,
    tag: '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png?v=20260407r12" />',
  },
];

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

function injectRequiredHeadTags(html) {
  if (!/<\/head>/i.test(html)) {
    return html;
  }

  const missingTags = REQUIRED_HEAD_TAGS
    .filter(({ test }) => !test.test(html))
    .map(({ tag }) => `  ${tag}`);

  if (missingTags.length === 0) {
    return html;
  }

  const injection = `\n${missingTags.join('\n')}\n`;
  return html.replace(/<\/head>/i, `${injection}</head>`);
}

function normalizePwaHeadTags(html) {
  return html
    .replace(/\s*<meta[^>]*name=["']theme-color["'][^>]*>\s*/gi, '\n')
    .replace(/\s*<link[^>]*rel=["']manifest["'][^>]*>\s*/gi, '\n')
    .replace(/\s*<link[^>]*rel=["']apple-touch-icon["'][^>]*>\s*/gi, '\n')
    .replace(/\s*<link[^>]*rel=["']icon["'][^>]*sizes=["']32x32["'][^>]*>\s*/gi, '\n')
    .replace(/\s*<link[^>]*rel=["']icon["'][^>]*sizes=["']16x16["'][^>]*>\s*/gi, '\n');
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

  next = normalizePwaHeadTags(next);
  next = injectRequiredHeadTags(next);

  if (next !== html) {
    fs.writeFileSync(file, next, 'utf8');
  }
}

console.log('[strip-html-comments] processed', htmlFiles.length, 'HTML file(s)');
