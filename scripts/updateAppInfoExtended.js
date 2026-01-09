// Lightweight local logger (avoids TS path alias issues in plain Node script)
const logger = {
  debug: console.log.bind(console, '[update-appinfo]'),
  warn: console.warn.bind(console, '[update-appinfo]'),
  error: console.error.bind(console, '[update-appinfo]')
};

// Attempt automatic service account bootstrap if running against prod and GOOGLE_APPLICATION_CREDENTIALS not set.
function ensureServiceAccountIfPossible(projectId){
  if (process.env.FIRESTORE_EMULATOR_HOST) return; // emulator path
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return; // already provided
  const fs = require('fs');
  const path = require('path');
  const b64Path = path.join(process.cwd(), 'backend-runtime', 'firebase_sa.b64');
  if (!fs.existsSync(b64Path)) {
    logger.warn('No firebase_sa.b64 found and no GOOGLE_APPLICATION_CREDENTIALS set; relying on applicationDefault()');
    return;
  }
  try {
    const raw = fs.readFileSync(b64Path, 'utf8').trim();
    const json = Buffer.from(raw, 'base64').toString('utf8');
    const tmpPath = path.join(process.cwd(), '.tmp-service-account.json');
    fs.writeFileSync(tmpPath, json, { mode: 0o600 });
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpPath;
    logger.debug('Loaded service account from base64 file');
  } catch (e) {
    logger.error('Failed to decode firebase_sa.b64', e);
  }
}
/*
 * Script: updateAppInfoExtended.js
 * Purpose: Merge newly added extended appInfo fields (media, deviceServices, dataAndStorage, tooling, expanded features list)
 *          into the Firestore settings document (appSettings/globalSettings) without overwriting existing custom values.
 *
 * Usage (Emulator):
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 node scripts/updateAppInfoExtended.js
 *
 * Usage (Prod with service account):
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json FIREBASE_PROJECT_ID=your_project node scripts/updateAppInfoExtended.js
 */

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const COLLECTION = 'appSettings';
const DOC_ID = 'globalSettings';

// New sections to merge (keep in sync with DEFAULT_SETTINGS in services/settingsService.ts)
const NEW_FIELDS = {
  'appInfo.media': {
    capture: ['Camera', 'Image Picker', 'Document Picker'],
    playback: ['Audio Playback', 'Video Playback'],
    fileTypes: ['Images', 'PDF', 'Docs', 'Spreadsheets', 'Audio']
  },
  'appInfo.deviceServices': {
    sensors: ['Device Info', 'Network Status', 'Localization', 'Notifications'],
    system: ['Haptics', 'App Updates', 'Splash Screen Control'],
    internationalization: ['English', 'Hindi (UI / Communications)'],
    network: ['Offline Detection', 'Retry Logic']
  },
  'appInfo.dataAndStorage': {
    exportImport: ['XLSX Export', 'XLSX Import (planned)', 'Structured Firestore Data'],
    local: ['AsyncStorage Session Cache'],
    cloud: ['Firestore Collections', 'Firebase Storage Files'],
    audit: ['Device Tracking Logs', 'Job Execution Audit', 'Reminder History']
  },
  'appInfo.tooling': {
    scripts: ['init:settings', 'setup:data', 'deploy:firestore', 'migrate:logs', 'app:status'],
    deployment: ['Expo Build', 'Firebase Hosting', 'Fly.io (backend-runtime)'],
    quality: ['TypeScript', 'ESLint', 'Patch Package']
  }
};

// Full replacement candidate for features (merged as a set to avoid duplicates)
const NEW_FEATURES = [
  'Student Management',
  'Fee Tracking & Reminders',
  'Multi-channel Communication',
  'Data Export/Import',
  'Real-time Chat',
  'File Sharing',
  'Dark/Light Theme',
  'Offline Support',
  'User Authorization',
  'Profile Management',
  'Enhanced Device Tracking & Audit Logs',
  'WhatsApp / SMS / Email Notifications',
  'In-app Technical App Info Modal',
  'Account Deletion Request Flow',
  'Bug Reporting Integration',
  'Advanced Security Rules (Role-Based)',
  'Google OAuth PKCE Authentication',
  'Push Notifications (FCM)',
  'Audio Playback & Ambient Birthday Experience',
  'Birthday Celebration UI (Confetti, Music, Candles)',
  'File Viewer (Images, Docs, PDFs)',
  'Excel (XLSX) Data Export',
  'Admin Settings Management',
  'Feature Flags (Non‑Admin History Visibility)',
  'Custom Themed UI Components',
  'Responsive Web Support',
  'Device & Session Awareness',
  'In-app Support Center'
];

async function main() {
  try {
  const projectId = process.env.FIREBASE_PROJECT_ID || 'demo-project';
  ensureServiceAccountIfPossible(projectId);
    const useEmulator = !!process.env.FIRESTORE_EMULATOR_HOST;
    if (useEmulator) {
      logger.debug('Using Firestore emulator at', process.env.FIRESTORE_EMULATOR_HOST);
      initializeApp({ projectId });
    } else {
      logger.debug('Using production / real Firestore (applicationDefault credentials)');
      initializeApp({ projectId, credential: applicationDefault() });
    }
    const db = getFirestore();

    const ref = db.collection(COLLECTION).doc(DOC_ID);
    let snap;
    try {
      snap = await ref.get();
    } catch (credErr) {
      logger.error('Failed to access Firestore. If running locally without credentials, set FIRESTORE_EMULATOR_HOST or provide GOOGLE_APPLICATION_CREDENTIALS.');
      throw credErr;
    }
    if (!snap.exists) {
      if (!process.env.CREATE_IF_MISSING) {
        logger.warn(`Settings document ${COLLECTION}/${DOC_ID} does not exist. Aborting (run init first) or set CREATE_IF_MISSING=1.`);
        return;
      }
      logger.debug('Document missing; creating baseline with extended fields...');
      const baseline = {
        supportEmail: 'support@example.com',
        supportPhone: '+1000000000',
        whatsappNumber: '+1000000000',
        bugReportFormUrl: 'https://forms.google.com/your-form',
        allowNonAdminAllReminderHistory: false,
        hideAuthorizedEmailsForNonAdmins: false,
        appInfo: {
          version: '1.0.0',
            build: '202412.1',
            releaseDate: 'December 2024',
            frontend: { framework: 'React Native (Expo)', language: 'TypeScript', ui: ['NativeWind','Tailwind CSS','Custom Components'], navigation: 'Expo Router' },
            backend: { database: ['Firebase Firestore','AsyncStorage'], authentication: 'Firebase Auth (Google)', storage: 'Firebase Storage', hosting: 'Firebase Hosting' },
            apis: { messaging: ['Twilio SMS','WhatsApp Business API','Email JS'], notifications: 'Firebase Cloud Messaging', fileUpload: 'Firebase Storage', maps: 'Google Maps API' },
            development: { ide: 'Visual Studio Code', versionControl: 'Git & GitHub', packageManager: 'npm', buildTool: 'Expo CLI' },
            libraries: { ui: ['Lucide React Native','React Native Reanimated','React Hook Form'], utilities: ['date-fns','lodash','crypto-js'], icons: 'Lucide Icons', fonts: ['Poppins','Inter'] },
            features: NEW_FEATURES,
            security: { authentication: ['OAuth 2.0','Firebase Security Rules'], authorization: 'Role-based Access Control', dataEncryption: 'AES-256 Encryption' },
            performance: { caching: 'AsyncStorage Caching', optimization: ['Code Splitting','Lazy Loading','Image Optimization'], monitoring: 'Firebase Analytics' },
            media: NEW_FIELDS['appInfo.media'],
            deviceServices: NEW_FIELDS['appInfo.deviceServices'],
            dataAndStorage: NEW_FIELDS['appInfo.dataAndStorage'],
            tooling: NEW_FIELDS['appInfo.tooling']
        },
        supportInfo: { businessHours: 'Mon-Fri 9am-6pm', responseTime: 'Within 24 hours', languages: ['English','Hindi'], channels: ['Email','WhatsApp','Phone','In-app Support'] },
        legal: { privacyPolicyUrl: 'https://example.com/privacy', termsOfServiceUrl: 'https://example.com/terms', licensingInfo: 'MIT License - Open Source' },
        social: { website: 'https://example.com', linkedin: '', twitter: '', github: '' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await ref.set(baseline);
      logger.debug('Baseline settings created with extended fields.');
      return; // done
    }

    const data = snap.data() || {};
    if (!data.appInfo) {
      data.appInfo = {}; // ensure container exists
    }
    const updates = {};

    // Merge feature list
    const existingFeatures = (data.appInfo && Array.isArray(data.appInfo.features)) ? data.appInfo.features : [];
    const mergedFeatures = Array.from(new Set([...existingFeatures, ...NEW_FEATURES]));
    updates['appInfo.features'] = mergedFeatures;

    // Add new structured sections only if missing or to extend arrays
    for (const [path, value] of Object.entries(NEW_FIELDS)) {
      const segments = path.split('.');
      let cursor = data;
      let exists = true;
      for (const seg of segments) {
        if (cursor && Object.prototype.hasOwnProperty.call(cursor, seg)) {
          cursor = cursor[seg];
        } else {
          exists = false;
          break;
        }
      }
      if (!exists) {
        updates[path] = value;
      } else if (typeof cursor === 'object' && cursor) {
        // Merge keys individually without overwriting arrays entirely if already present
        const mergedSub = { ...value };
        for (const key of Object.keys(value)) {
          if (Array.isArray(value[key]) && Array.isArray(cursor[key])) {
            mergedSub[key] = Array.from(new Set([...cursor[key], ...value[key]]));
          } else if (!(key in cursor)) {
            mergedSub[key] = value[key];
          } else {
            mergedSub[key] = cursor[key]; // keep existing
          }
        }
        updates[path] = mergedSub;
      }
    }

    if (Object.keys(updates).length === 0) {
      logger.debug('No updates required. Already up to date.');
      return;
    }

    updates.updatedAt = new Date().toISOString();

  logger.debug('Applying updates:', JSON.stringify(updates, null, 2));
  await ref.set(updates, { merge: true });
  logger.debug('App settings extended fields updated successfully (keys added:', Object.keys(updates).join(', '), ')');
  } catch (err) {
    logger.error('Failed to update extended app info', err);
    process.exitCode = 2;
  }
}

main();
