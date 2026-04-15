import assert from 'assert';
import { buildCsp, cspMiddleware } from '../dist/csp.js';
import express from 'express';
import * as http from 'http';
import fs from 'fs';
import path from 'path';

// Prepare a temporary hash manifest to exercise hashed branches
const manifestPath = path.join(process.cwd(), 'temp-hashes.json');
fs.writeFileSync(manifestPath, JSON.stringify({ style: ["'sha256-deadbeef'"], script: ["'sha256-cafebabe'"] }));

try {
  // Direct function coverage for buildCsp with reportOnly true
  const ro = buildCsp({ hashManifestPath: manifestPath, reportOnly: true });
  assert.equal(ro.headerName, 'Content-Security-Policy-Report-Only');
  assert(ro.policy.includes("'sha256-cafebabe'"), 'Script hash should appear');
  const styleSrc = ro.policy.split('; ').find((part) => part.startsWith('style-src ')) || '';
  assert(styleSrc.includes("'sha256-deadbeef'"), 'Style hash should appear in style-src');
  assert(!styleSrc.includes("'unsafe-inline'"), 'unsafe-inline should be dropped from style-src when style hashes are present');

  // Middleware coverage: enableReportOnlyHeader + accept header gating
  const app = express();
  app.use(cspMiddleware({ enableReportOnlyHeader: true, hashManifestPath: manifestPath }));
  app.get('/test', (req,res)=> res.send('<html><body>ok</body></html>'));

  // A second app instance to cover env-driven report-only branch without enableReportOnlyHeader
  const appEnv = express();
  appEnv.use((req,res,next)=>{ process.env.CSP_REPORT_ONLY_MODE = '1'; next(); });
  appEnv.use(cspMiddleware({ hashManifestPath: manifestPath }));
  appEnv.get('/test', (req,res)=> res.send('<html><body>ok2</body></html>'));

  const server = http.createServer(app);
  await new Promise(r=>server.listen(0,r));
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/test`, { headers: { Accept: 'text/html' } });
  const headers = Object.fromEntries(res.headers.entries());
  assert(headers['content-security-policy'], 'CSP header expected');
  assert(headers['content-security-policy-report-only'], 'Report-Only header expected (enableReportOnlyHeader)');
  assert(headers['content-security-policy'].includes("'sha256-cafebabe'"), 'Enforcement header should include script hash (hash manifest)');
  server.close();

  const serverEnv = http.createServer(appEnv);
  await new Promise(r=>serverEnv.listen(0,r));
  const portEnv = serverEnv.address().port;
  const resEnv = await fetch(`http://127.0.0.1:${portEnv}/test`, { headers: { Accept: 'text/html' } });
  const headersEnv = Object.fromEntries(resEnv.headers.entries());
  assert(headersEnv['content-security-policy'], 'CSP header expected (env branch)');
  assert(headersEnv['content-security-policy-report-only'], 'Report-Only header expected via env variable');
  serverEnv.close();
} finally {
  if (fs.existsSync(manifestPath)) {
    fs.unlinkSync(manifestPath);
  }
}
