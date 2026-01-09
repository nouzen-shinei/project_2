import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../..');
const sharedPlanLimitsPath = path.resolve(repoRoot, 'lib/planLimits.ts');
console.log('[vite] shared plan limits alias ->', sharedPlanLimitsPath);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared/planLimits': sharedPlanLimitsPath,
    },
  },
  server: {
    port: 5174,
    fs: {
      allow: [repoRoot],
    },
  },
});
