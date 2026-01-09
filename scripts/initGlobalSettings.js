// Initialize appSettings/globalSettings with minimal baseline (extended) if missing.
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const logger = {
  debug: console.log.bind(console, '[init-settings]'),
  warn: console.warn.bind(console, '[init-settings]'),
  error: console.error.bind(console, '[init-settings]')
};

async function main(){
  const projectId = process.env.FIREBASE_PROJECT_ID || 'demo-project';
  const useEmu = !!process.env.FIRESTORE_EMULATOR_HOST;
  if(useEmu){
    logger.debug('Using emulator', process.env.FIRESTORE_EMULATOR_HOST);
    initializeApp({ projectId });
  } else {
    initializeApp({ projectId, credential: applicationDefault() });
  }
  const db = getFirestore();
  const ref = db.collection('appSettings').doc('globalSettings');
  const snap = await ref.get();
  if(snap.exists){
    logger.debug('Already exists; skipping');
    // Still ensure runtimeEndpoints exists for backend URL remote control.
    const endpointsRef = db.collection('appSettings').doc('runtimeEndpoints');
    const endpointsSnap = await endpointsRef.get();
    if(!endpointsSnap.exists){
      const now = new Date().toISOString();
      const apiBaseUrl = (process.env.EXPO_PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
      const emailApiBaseUrl = (process.env.EXPO_PUBLIC_EMAIL_API_BASE_URL || process.env.EMAIL_API_BASE_URL || '').trim().replace(/\/+$/, '');
      await endpointsRef.set({
        apiBaseUrl: apiBaseUrl || undefined,
        emailApiBaseUrl: emailApiBaseUrl || undefined,
        notificationsApiBaseUrl: (process.env.EXPO_PUBLIC_NOTIFICATIONS_API_BASE_URL || '').trim().replace(/\/+$/, '') || undefined,
        wabaApiBaseUrl: (process.env.EXPO_PUBLIC_WABA_API_BASE_URL || '').trim().replace(/\/+$/, '') || undefined,
        chatApiBaseUrl: (process.env.EXPO_PUBLIC_CHAT_API_BASE_URL || '').trim().replace(/\/+$/, '') || undefined,
        updatedAt: now,
        createdAt: now,
      });
      logger.debug('Initialized runtimeEndpoints doc');
    }
    return;
  }
  const payload = {
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
      features: ['Student Management','Fee Tracking & Reminders','Multi-channel Communication','Data Export/Import','Real-time Chat','File Sharing','Dark/Light Theme','Offline Support','User Authorization','Profile Management'],
      security: { authentication: ['OAuth 2.0','Firebase Security Rules'], authorization: 'Role-based Access Control', dataEncryption: 'AES-256 Encryption' },
      performance: { caching: 'AsyncStorage Caching', optimization: ['Code Splitting','Lazy Loading','Image Optimization'], monitoring: 'Firebase Analytics' }
    },
    supportInfo: { businessHours: 'Mon-Fri 9am-6pm', responseTime: 'Within 24 hours', languages: ['English','Hindi'], channels: ['Email','WhatsApp','Phone','In-app Support'] },
    legal: { privacyPolicyUrl: 'https://example.com/privacy', termsOfServiceUrl: 'https://example.com/terms', licensingInfo: 'MIT License - Open Source' },
    social: { website: 'https://example.com', linkedin: '', twitter: '', github: '' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  await ref.set(payload);
  logger.debug('Initialized global settings');

  // Also create the runtime endpoints doc for remote backend URL changes.
  const endpointsRef = db.collection('appSettings').doc('runtimeEndpoints');
  const now = new Date().toISOString();
  const apiBaseUrl = (process.env.EXPO_PUBLIC_API_BASE_URL || process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
  const emailApiBaseUrl = (process.env.EXPO_PUBLIC_EMAIL_API_BASE_URL || process.env.EMAIL_API_BASE_URL || '').trim().replace(/\/+$/, '');
  await endpointsRef.set({
    apiBaseUrl: apiBaseUrl || undefined,
    emailApiBaseUrl: emailApiBaseUrl || undefined,
    notificationsApiBaseUrl: (process.env.EXPO_PUBLIC_NOTIFICATIONS_API_BASE_URL || '').trim().replace(/\/+$/, '') || undefined,
    wabaApiBaseUrl: (process.env.EXPO_PUBLIC_WABA_API_BASE_URL || '').trim().replace(/\/+$/, '') || undefined,
    chatApiBaseUrl: (process.env.EXPO_PUBLIC_CHAT_API_BASE_URL || '').trim().replace(/\/+$/, '') || undefined,
    updatedAt: now,
    createdAt: now,
  });
  logger.debug('Initialized runtimeEndpoints doc');
}

main().catch(e=>{ logger.error(e); process.exitCode=2; });
