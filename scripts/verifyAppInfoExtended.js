// Verifies extended appInfo fields exist in Firestore (emulator or prod)
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const logger = {
  info: console.log.bind(console, '[verify-appinfo]'),
  warn: console.warn.bind(console, '[verify-appinfo]'),
  error: console.error.bind(console, '[verify-appinfo]')
};

function ensureServiceAccount(){
  if (process.env.FIRESTORE_EMULATOR_HOST) return;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  const fs = require('fs');
  const path = require('path');
  const b64 = path.join(process.cwd(),'backend-runtime','firebase_sa.b64');
  if (!fs.existsSync(b64)) { logger.warn('No service account found; relying on gcloud / ADC'); return; }
  try {
    const raw = fs.readFileSync(b64,'utf8').trim();
    const json = Buffer.from(raw,'base64').toString('utf8');
    const out = path.join(process.cwd(),'.tmp-service-account.json');
    fs.writeFileSync(out,json,{mode:0o600});
    process.env.GOOGLE_APPLICATION_CREDENTIALS = out;
    logger.info('Loaded service account from firebase_sa.b64');
  } catch(e){ logger.error('Failed decoding service account', e); }
}

async function main(){
  const projectId = process.env.FIREBASE_PROJECT_ID || 'demo-project';
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    logger.info('Using emulator', process.env.FIRESTORE_EMULATOR_HOST);
    initializeApp({ projectId });
  } else {
    ensureServiceAccount();
    initializeApp({ projectId, credential: applicationDefault() });
  }
  const db = getFirestore();
  const snap = await db.collection('appSettings').doc('globalSettings').get();
  if (!snap.exists){
    logger.warn('Document appSettings/globalSettings not found');
    return;
  }
  const d = snap.data();
  const ai = d.appInfo || {};
  const expectedSections = ['media','deviceServices','dataAndStorage','tooling'];
  const report = expectedSections.map(k => `${k}:${ai[k] ? 'OK' : 'MISSING'}`);
  logger.info('appInfo keys:', Object.keys(ai));
  logger.info('Section status:', report.join(', '));
  logger.info('Features count:', Array.isArray(ai.features)? ai.features.length : 0);
  if (Array.isArray(ai.features)) logger.info('First 5 features:', ai.features.slice(0,5));
}

main().catch(e=>{console.error(e);process.exitCode=2;});
