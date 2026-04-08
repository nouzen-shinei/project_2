import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';

const ROOT = process.cwd();
const SOURCE_ICON = path.join(ROOT, 'assets/images/icon.png');

const ICON_TASKS = [
  { out: 'public/pwa/icon-1024.png', size: 1024 },
  { out: 'public/pwa/icon-512.png', size: 512 },
  { out: 'public/pwa/icon-512-maskable.png', size: 512 },
  { out: 'public/pwa/icon-192.png', size: 192 },
  { out: 'public/pwa/icon-192-maskable.png', size: 192 },
  { out: 'public/pwa/apple-touch-icon-180.png', size: 180 },
  { out: 'public/pwa/icon-144.png', size: 144 },
  { out: 'public/pwa/icon-96.png', size: 96 },
  { out: 'public/pwa/icon-72.png', size: 72 },
  { out: 'public/android-chrome-512x512.png', size: 512 },
  { out: 'public/android-chrome-192x192.png', size: 192 },
  { out: 'public/apple-touch-icon.png', size: 180 },
  { out: 'public/favicon-32x32.png', size: 32 },
  { out: 'public/favicon-16x16.png', size: 16 },
];

function runSipsResize(inputPath, outputPath, size) {
  const result = spawnSync('sips', ['-z', String(size), String(size), inputPath, '--out', outputPath], {
    stdio: 'ignore',
  });

  if (result.status !== 0) {
    throw new Error(`sips resize failed for ${outputPath}`);
  }
}

function cornerAlphaScale(x, y, centerX, centerY, radius) {
  const dx = x + 0.5 - centerX;
  const dy = y + 0.5 - centerY;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const hardRadius = radius - 0.5;
  const softRadius = radius + 0.5;

  if (distance <= hardRadius) {
    return 1;
  }

  if (distance >= softRadius) {
    return 0;
  }

  return Math.max(0, Math.min(1, softRadius - distance));
}

function applyRoundedMask(filePath, radiusRatio = 0.22) {
  const fileBuffer = fs.readFileSync(filePath);
  const png = PNG.sync.read(fileBuffer);
  const { width, height, data } = png;

  const radius = Math.max(1, Math.round(Math.min(width, height) * radiusRatio));
  const rightCenterX = width - radius;
  const bottomCenterY = height - radius;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let scale = 1;

      if (x < radius && y < radius) {
        scale = Math.min(scale, cornerAlphaScale(x, y, radius, radius, radius));
      }

      if (x >= width - radius && y < radius) {
        scale = Math.min(scale, cornerAlphaScale(x, y, rightCenterX, radius, radius));
      }

      if (x < radius && y >= height - radius) {
        scale = Math.min(scale, cornerAlphaScale(x, y, radius, bottomCenterY, radius));
      }

      if (x >= width - radius && y >= height - radius) {
        scale = Math.min(scale, cornerAlphaScale(x, y, rightCenterX, bottomCenterY, radius));
      }

      if (scale < 1) {
        const redIndex = (width * y + x) * 4;
        const greenIndex = redIndex + 1;
        const blueIndex = redIndex + 2;
        const alphaIndex = (width * y + x) * 4 + 3;
        const nextAlpha = Math.round(data[alphaIndex] * scale);
        data[alphaIndex] = nextAlpha;

        // Some PWA splash renderers flatten alpha; force fully transparent
        // corners to white so rounded corners stay visually rounded.
        if (nextAlpha === 0) {
          data[redIndex] = 255;
          data[greenIndex] = 255;
          data[blueIndex] = 255;
        }
      }
    }
  }

  fs.writeFileSync(filePath, PNG.sync.write(png));
}

function main() {
  if (!fs.existsSync(SOURCE_ICON)) {
    throw new Error(`Source icon missing: ${SOURCE_ICON}`);
  }

  for (const task of ICON_TASKS) {
    const outputPath = path.join(ROOT, task.out);
    runSipsResize(SOURCE_ICON, outputPath, task.size);
    applyRoundedMask(outputPath);
  }

  console.log('Rounded transparent PWA icons generated successfully.');
}

main();
