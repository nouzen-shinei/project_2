import assert from 'assert';
import { createApp } from '../dist/app.js';
import * as http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

function decodeServiceAccount(raw){
  if(!raw) return null;
  const trimmed = raw.trim();
  let jsonStr = trimmed;
  if(!trimmed.startsWith('{')){ // assume base64
    try { jsonStr = Buffer.from(trimmed,'base64').toString('utf8'); } catch { return null; }
  }
  try { return JSON.parse(jsonStr); } catch { return null; }
}

// Determine presence of a service account via env var or fallback file (firebase_sa.b64)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fallbackPath = path.resolve(__dirname, '../firebase_sa.b64');

let rawSa = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
if(!rawSa && fs.existsSync(fallbackPath)){
  try { rawSa = fs.readFileSync(fallbackPath, 'utf8'); } catch {/* ignore */}
}

const svc = decodeServiceAccount(rawSa);
const serviceAccountPresent = !!svc;

if(!serviceAccountPresent){
  console.log('[cspPrune.test] Skipped (service account missing or invalid)');
  process.exit(0);
}

(async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(r=>server.listen(0,r));
  const port = server.address().port; // retained if needed for future endpoint testing

  const admin = await import('firebase-admin');
  let db;
  let primaryError;
  // Legacy namespaced attempt
  try {
    if(typeof admin.firestore === 'function') {
      db = admin.firestore();
    }
  } catch(e){ primaryError = e; }

  // Modular fallback (initialize if not already)
  if(!db){
    try {
      const { getApps, initializeApp, applicationDefault, cert } = await import('firebase-admin/app');
      const { getFirestore } = await import('firebase-admin/firestore');
      if(!getApps().length){
        try {
          if(svc){
            initializeApp({ credential: cert(svc) });
          } else {
            initializeApp({ credential: applicationDefault() });
          }
        } catch(initErr){
          primaryError = primaryError || initErr;
        }
      }
      try { db = getFirestore(); } catch(getErr){ primaryError = primaryError || getErr; }
    } catch(modErr){ primaryError = primaryError || modErr; }
  }

  if(!db){
    server.close();
    const msg = '[cspPrune.test] Firestore unavailable (service account present). ' + (primaryError ? 'Reason: '+ (primaryError.message || primaryError) : '');
    if(process.env.CI){
      throw new Error(msg);
    } else {
      console.log(msg + ' -- skipping locally (set CI=1 to enforce failure).');
      process.exit(0);
    }
  }

  const col = db.collection('security_csp_violations');
  const oldTs = Date.now() - 10*24*60*60*1000; // 10 days ago
  await col.add({ effectiveDirective: 'script-src', receivedAt: oldTs });
  await col.add({ effectiveDirective: 'style-src', receivedAt: oldTs });

  await (app)._pruneCspViolations();

  const snap = await col.where('receivedAt','<', Date.now() - 7*24*60*60*1000).get();
  assert.equal(snap.size, 0, 'Old violations should be pruned');

  server.close();
})();
