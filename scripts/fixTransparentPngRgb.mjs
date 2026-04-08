#!/usr/bin/env node
import fs from 'fs';
import { PNG } from 'pngjs';

const args = process.argv.slice(2);
if (args.length < 4) {
  console.error('Usage: node scripts/fixTransparentPngRgb.mjs <r> <g> <b> <file...>');
  process.exit(1);
}

const r = Number(args[0]);
const g = Number(args[1]);
const b = Number(args[2]);
const files = args.slice(3);

if ([r, g, b].some((v) => Number.isNaN(v) || v < 0 || v > 255)) {
  console.error('Invalid RGB values. Expected 0-255.');
  process.exit(1);
}

for (const filePath of files) {
  if (!fs.existsSync(filePath)) {
    console.error(`[fix-transparent-rgb] missing file: ${filePath}`);
    process.exit(1);
  }

  const png = PNG.sync.read(fs.readFileSync(filePath));
  const data = png.data;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }

  fs.writeFileSync(filePath, PNG.sync.write(png));
}

console.log(`[fix-transparent-rgb] processed ${files.length} file(s)`);