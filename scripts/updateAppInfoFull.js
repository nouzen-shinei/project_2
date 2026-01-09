// updateAppInfoFull.js
// Purpose: Force a full replacement (merge) of appInfo with extended sections.
// Avoids dotted path merge edge cases. Includes diff output.
//
// Usage (Production):
//   base64 -d backend-runtime/firebase_sa.b64 > sa.json
//   export GOOGLE_APPLICATION_CREDENTIALS=$PWD/sa.json
//   export FIREBASE_PROJECT_ID=your_real_project_id
//   node scripts/updateAppInfoFull.js
//
// Usage (Emulator):
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node scripts/updateAppInfoFull.js

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const logger = {
  info: console.log.bind(console,'[appinfo-full]'),
  warn: console.warn.bind(console,'[appinfo-full]'),
  error: console.error.bind(console,'[appinfo-full]')
};

function loadServiceAccountIfNeeded(){
  if (process.env.FIRESTORE_EMULATOR_HOST) return;
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return;
  const fs = require('fs');
  const path = require('path');
  const b64 = path.join(process.cwd(),'backend-runtime','firebase_sa.b64');
  if(!fs.existsSync(b64)){ logger.warn('No service account & no GOOGLE_APPLICATION_CREDENTIALS; relying on applicationDefault()'); return; }
  try {
    const raw = fs.readFileSync(b64,'utf8').trim();
    const json = Buffer.from(raw,'base64').toString('utf8');
    const out = path.join(process.cwd(),'.tmp-service-account-full.json');
    fs.writeFileSync(out,json,{mode:0o600});
    process.env.GOOGLE_APPLICATION_CREDENTIALS = out;
    logger.info('Decoded service account from firebase_sa.b64');
  } catch(e){ logger.error('Failed decoding service account', e); }
}

const EXT_SECTIONS = {
  media: {
    capture: ['Camera','Image Picker','Document Picker'],
    playback: ['Audio Playback','Video Playback'],
    fileTypes: ['Images','PDF','Docs','Spreadsheets','Audio']
  },
  deviceServices: {
    sensors: ['Device Info','Network Status','Localization','Notifications'],
    system: ['Haptics','App Updates','Splash Screen Control'],
    internationalization: ['English','Hindi (UI / Communications)'],
    network: ['Offline Detection','Retry Logic']
  },
  dataAndStorage: {
    exportImport: ['XLSX Export','XLSX Import (planned)','Structured Firestore Data'],
    local: ['AsyncStorage Session Cache'],
    cloud: ['Firestore Collections','Firebase Storage Files'],
    audit: ['Device Tracking Logs','Job Execution Audit','Reminder History']
  },
  tooling: {
    scripts: ['init:settings','setup:data','deploy:firestore','migrate:logs','app:status'],
    deployment: ['Expo Build','Firebase Hosting','Fly.io (backend-runtime)'],
    quality: ['TypeScript','ESLint','Patch Package']
  }
};

const FEATURES = [
  'Student Management','Fee Tracking & Reminders','Multi-channel Communication','Data Export/Import','Real-time Chat','File Sharing','Dark/Light Theme','Offline Support','User Authorization','Profile Management','Enhanced Device Tracking & Audit Logs','WhatsApp / SMS / Email Notifications','In-app Technical App Info Modal','Account Deletion Request Flow','Bug Reporting Integration','Advanced Security Rules (Role-Based)','Google OAuth PKCE Authentication','Push Notifications (FCM)','Audio Playback & Ambient Birthday Experience','Birthday Celebration UI (Confetti, Music, Candles)','File Viewer (Images, Docs, PDFs)','Excel (XLSX) Data Export','Admin Settings Management','Feature Flags (Non‑Admin History Visibility)','Custom Themed UI Components','Responsive Web Support','Device & Session Awareness','In-app Support Center'
];

async function main(){
  // Fallback order for project id: explicit FIREBASE_PROJECT_ID -> EXPO_PUBLIC_FIREBASE_PROJECT_ID -> demo-project
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || 'demo-project';
  const usingEmu = !!process.env.FIRESTORE_EMULATOR_HOST;
  loadServiceAccountIfNeeded();
  if(usingEmu){
    logger.info('Using emulator', process.env.FIRESTORE_EMULATOR_HOST);
    initializeApp({ projectId });
  } else {
    logger.info('Using project', projectId);
    try {
      // Before initializing, emit some diagnostics if GOOGLE_APPLICATION_CREDENTIALS is set.
      const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
      if (credPath) {
        const fs = require('fs');
        if (fs.existsSync(credPath)) {
          const size = fs.statSync(credPath).size;
            if(size === 0){
              logger.warn('Credential file is empty (size 0). This will cause JSON parse errors. Delete it or regenerate.');
            }
            else {
              // Light sanity check: begins with '{'
              const firstBytes = fs.readFileSync(credPath, {encoding:'utf8', flag:'r'}).slice(0,1);
              if(firstBytes !== '{') {
                logger.warn('Credential file does not start with "{". It may not be decoded correctly.');
              }
            }
        } else {
          logger.warn('GOOGLE_APPLICATION_CREDENTIALS points to non-existent file:', credPath);
        }
      } else {
        logger.info('No GOOGLE_APPLICATION_CREDENTIALS set – relying on applicationDefault() / metadata env');
      }
      initializeApp({ projectId, credential: applicationDefault() });
    } catch (e) {
      logger.error('Initialization failed. If this is a JSON parse error, recreate service account file. Falling back to emulator style init WITHOUT credentials.');
      initializeApp({ projectId });
    }
  }
  const db = getFirestore();
  const ref = db.collection('appSettings').doc('globalSettings');
  const snap = await ref.get();
  if(!snap.exists){
    logger.warn('Document missing; creating new full document (CREATE_IF_MISSING implied).');
  }
  const existing = snap.exists ? snap.data() : {};
  const prevAppInfo = existing.appInfo || {};
  const newAppInfo = {
    version: prevAppInfo.version || '1.0.0',
    build: prevAppInfo.build || '202412.1',
    releaseDate: prevAppInfo.releaseDate || 'December 2024',
    frontend: prevAppInfo.frontend || { framework:'React Native (Expo)', language:'TypeScript', ui:['NativeWind','Tailwind CSS','Custom Components'], navigation:'Expo Router' },
    backend: prevAppInfo.backend || { database:['Firebase Firestore','AsyncStorage'], authentication:'Firebase Auth (Google)', storage:'Firebase Storage', hosting:'Firebase Hosting' },
    apis: prevAppInfo.apis || { messaging:['Twilio SMS','WhatsApp Business API','Email JS'], notifications:'Firebase Cloud Messaging', fileUpload:'Firebase Storage', maps:'Google Maps API' },
    development: prevAppInfo.development || { ide:'Visual Studio Code', versionControl:'Git & GitHub', packageManager:'npm', buildTool:'Expo CLI' },
    libraries: prevAppInfo.libraries || { ui:['Lucide React Native','React Native Reanimated','React Hook Form'], utilities:['date-fns','lodash','crypto-js'], icons:'Lucide Icons', fonts:['Poppins','Inter'] },
    features: Array.from(new Set([...(prevAppInfo.features||[]), ...FEATURES])),
    security: prevAppInfo.security || { authentication:['OAuth 2.0','Firebase Security Rules'], authorization:'Role-based Access Control', dataEncryption:'AES-256 Encryption' },
    performance: prevAppInfo.performance || { caching:'AsyncStorage Caching', optimization:['Code Splitting','Lazy Loading','Image Optimization'], monitoring:'Firebase Analytics' },
    media: prevAppInfo.media || EXT_SECTIONS.media,
    deviceServices: prevAppInfo.deviceServices || EXT_SECTIONS.deviceServices,
    dataAndStorage: prevAppInfo.dataAndStorage || EXT_SECTIONS.dataAndStorage,
    tooling: prevAppInfo.tooling || EXT_SECTIONS.tooling
  };

  // Build diff summary
  const addedSections = ['media','deviceServices','dataAndStorage','tooling'].filter(k => !prevAppInfo[k]);
  const featureDelta = (newAppInfo.features.length - (prevAppInfo.features||[]).length);

  await ref.set({ appInfo: newAppInfo, updatedAt: new Date().toISOString() }, { merge: true });
  logger.info('Write complete. Added sections:', addedSections.join(', ') || 'none', 'Feature delta:', featureDelta);

  const verify = await ref.get();
  logger.info('Post-write appInfo keys:', Object.keys(verify.data().appInfo));
  logger.info('Post-write features count:', verify.data().appInfo.features.length);
}

main().catch(e=>{ logger.error('Update failed', e); process.exitCode=2; });
