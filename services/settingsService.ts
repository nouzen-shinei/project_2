import { logger } from '@/lib/logger';
import { doc, getDoc, setDoc, collection } from 'firebase/firestore';
import { firestore } from '../config/firebase';

export interface AppSettings {
  // Contact Information
  supportEmail: string;
  supportPhone: string;
  whatsappNumber: string;
  bugReportFormUrl: string;
  // Branding
  coachingName: string; // Name of the coaching/institute (used in reminders/signatures)
  
  // Feature flags / permissions
  allowNonAdminAllReminderHistory?: boolean; // if true, non-admins can view all reminder history
  hideAuthorizedEmailsForNonAdmins?: boolean; // if true, non-admins cannot view Authorized Emails page
  
  // App Information
  appInfo: {
    version: string;
    build: string;
    releaseDate: string;
    
    // Technical Stack
    frontend: {
      framework: string;
      language: string;
      ui: string[];
      navigation: string;
    };
    
    backend: {
      database: string[];
      authentication: string;
      storage: string;
      hosting: string;
    };
    
    apis: {
      messaging: string[];
      notifications: string;
      fileUpload: string;
      maps: string;
    };
    
    development: {
      ide: string;
      versionControl: string;
      packageManager: string;
      buildTool: string;
    };
    
    libraries: {
      ui: string[];
      utilities: string[];
      icons: string;
      fonts: string[];
    };
    
    features: string[];
    
    security: {
      authentication: string[];
      authorization: string;
      dataEncryption: string;
    };
    
    performance: {
      caching: string;
      optimization: string[];
      monitoring: string;
    };

    // Media & Device Capabilities (new)
    media?: {
      capture: string[]; // e.g. Camera, Document Picker
      playback: string[]; // e.g. Audio, Video
      fileTypes: string[]; // Supported file categories
    };

    deviceServices?: {
      sensors: string[]; // Location, Network, Device Info
      system: string[]; // Haptics, App Lifecycle
      internationalization: string[]; // Localization / Languages
      network: string[]; // Online / Offline awareness libs/services
    };

    dataAndStorage?: {
      exportImport: string[]; // e.g. XLSX export/import
      local: string[]; // Async/local caches
      cloud: string[]; // Firestore / Storage buckets
      audit: string[]; // Tracking / logging / device audit
    };

    tooling?: {
      scripts: string[]; // Notable npm scripts or automation
      deployment: string[]; // Hosting / build systems
      quality: string[]; // Linting / typing / test infra
    };
  };
  
  // Support Information
  supportInfo: {
    businessHours: string;
    responseTime: string;
    languages: string[];
    channels: string[];
  };
  
  // Legal & Policy
  legal: {
    privacyPolicyUrl: string;
    termsOfServiceUrl: string;
    licensingInfo: string;
  };
  
  // Social Links
  social: {
    website: string;
    linkedin: string;
    twitter: string;
    github: string;
  };
}

const DEFAULT_SETTINGS: AppSettings = {
  supportEmail: 'krvikrantsingh51@gmail.com',
  supportPhone: '+919608208871',
  whatsappNumber: '+919608208871',
  bugReportFormUrl: 'https://forms.google.com/tuition-manager-bug-report',
  coachingName: 'S.S Tuition Classes',
  
  allowNonAdminAllReminderHistory: false,
  hideAuthorizedEmailsForNonAdmins: false,
  
  appInfo: {
    version: '1.0.0',
    build: '202412.1',
    releaseDate: 'December 2024',
    
    frontend: {
      framework: 'React Native (Expo)',
      language: 'TypeScript',
      ui: ['NativeWind', 'Tailwind CSS', 'Custom Components'],
      navigation: 'Expo Router'
    },
    
    backend: {
      database: ['Firebase Firestore', 'AsyncStorage'],
      authentication: 'Firebase Auth (Google)',
      storage: 'Firebase Storage',
      hosting: 'Firebase Hosting'
    },
    
    apis: {
      messaging: ['Twilio SMS', 'WhatsApp Business API', 'Email JS'],
      notifications: 'Firebase Cloud Messaging',
      fileUpload: 'Firebase Storage',
      maps: 'Google Maps API'
    },
    
    development: {
      ide: 'Visual Studio Code',
      versionControl: 'Git & GitHub',
      packageManager: 'npm',
      buildTool: 'Expo CLI'
    },
    
    libraries: {
      ui: ['Lucide React Native', 'React Native Reanimated', 'React Hook Form'],
      utilities: ['date-fns', 'lodash', 'crypto-js'],
      icons: 'Lucide Icons',
      fonts: ['Poppins', 'Inter']
    },
    
    features: [
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
    ],
    
    security: {
      authentication: ['OAuth 2.0', 'Firebase Security Rules'],
      authorization: 'Role-based Access Control',
      dataEncryption: 'AES-256 Encryption'
    },
    
    performance: {
      caching: 'AsyncStorage Caching',
      optimization: ['Code Splitting', 'Lazy Loading', 'Image Optimization'],
      monitoring: 'Firebase Analytics'
    },

    media: {
      capture: ['Camera', 'Image Picker', 'Document Picker'],
      playback: ['Audio Playback', 'Video Playback'],
      fileTypes: ['Images', 'PDF', 'Docs', 'Spreadsheets', 'Audio']
    },

    deviceServices: {
      sensors: ['Device Info', 'Network Status', 'Localization', 'Notifications'],
      system: ['Haptics', 'App Updates', 'Splash Screen Control'],
      internationalization: ['English', 'Hindi (UI / Communications)'],
      network: ['Offline Detection', 'Retry Logic']
    },

    dataAndStorage: {
      exportImport: ['XLSX Export', 'XLSX Import (planned)', 'Structured Firestore Data'],
      local: ['AsyncStorage Session Cache'],
      cloud: ['Firestore Collections', 'Firebase Storage Files'],
      audit: ['Device Tracking Logs', 'Job Execution Audit', 'Reminder History']
    },

    tooling: {
      scripts: ['init:settings', 'setup:data', 'deploy:firestore', 'migrate:logs', 'app:status'],
      deployment: ['Expo Build', 'Firebase Hosting', 'Fly.io (backend-runtime)'],
      quality: ['TypeScript', 'ESLint', 'Patch Package']
    }
  },
  
  supportInfo: {
    businessHours: 'Monday - Friday: 9:00 AM - 6:00 PM IST',
    responseTime: 'Within 24 hours',
    languages: ['English', 'Hindi'],
    channels: ['Email', 'WhatsApp', 'Phone', 'In-app Support']
  },
  
  legal: {
    privacyPolicyUrl: 'https://tuitionmanager.app/privacy-policy.html',
    termsOfServiceUrl: 'https://tuitionmanager.app/terms-of-service.html',
    licensingInfo: 'MIT License - Open Source'
  },
  
  social: {
    website: 'https://tuitionmanager.app',
    linkedin: 'https://www.linkedin.com/in/nouzen-shinei',
    twitter: 'https://x.com/nouzen_shinei_',
    github: 'https://github.com/nouzen-shinei'
  }
};

class SettingsService {
  private readonly COLLECTION_NAME = 'appSettings';
  private readonly DOCUMENT_ID = 'globalSettings';
  private cachedSettings: AppSettings | null = null;

  /**
   * Get app settings from Firestore
   */
  async getSettings(): Promise<AppSettings> {
    try {
      logger.debug('🔍 Checking for cached settings...');
      // Return cached settings if available
      if (this.cachedSettings) {
        logger.debug('✅ Using cached settings');
        return this.cachedSettings;
      }

      logger.debug('📡 Fetching settings from Firestore...');
      logger.debug(`📄 Collection: ${this.COLLECTION_NAME}, Document: ${this.DOCUMENT_ID}`);
      
      const settingsDoc = doc(firestore, this.COLLECTION_NAME, this.DOCUMENT_ID);
      const docSnap = await getDoc(settingsDoc);

      if (docSnap.exists()) {
        logger.debug('✅ Settings document found in Firestore');
        const settings = docSnap.data() as AppSettings;
        logger.debug('📞 Support Email from Firestore:', settings.supportEmail);
        logger.debug('📱 Support Phone from Firestore:', settings.supportPhone);
        this.cachedSettings = settings;
        return settings;
      } else {
        logger.debug('⚠️ No settings document found, creating default settings');
        // If no settings exist, create default settings
        await this.initializeDefaultSettings();
        return DEFAULT_SETTINGS;
      }
    } catch (error) {
      logger.error('❌ Error fetching settings:', error);
      // Return default settings if there's an error
      return DEFAULT_SETTINGS;
    }
  }

  /**
   * Initialize default settings in Firestore
   */
  async initializeDefaultSettings(): Promise<void> {
    try {
      const settingsDoc = doc(firestore, this.COLLECTION_NAME, this.DOCUMENT_ID);
      await setDoc(settingsDoc, {
        ...DEFAULT_SETTINGS,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      this.cachedSettings = DEFAULT_SETTINGS;
      logger.debug('Default settings initialized in Firestore');
    } catch (error) {
      logger.error('Error initializing default settings:', error);
    }
  }

  /**
   * Update settings in Firestore (Admin only)
   */
  async updateSettings(newSettings: Partial<AppSettings>): Promise<void> {
    try {
      const settingsDoc = doc(firestore, this.COLLECTION_NAME, this.DOCUMENT_ID);
      const currentSettings = await this.getSettings();
      
      const updatedSettings = {
        ...currentSettings,
        ...newSettings,
        updatedAt: new Date().toISOString()
      };

      await setDoc(settingsDoc, updatedSettings, { merge: true });
      this.cachedSettings = updatedSettings;
      logger.debug('Settings updated successfully');
    } catch (error) {
      logger.error('Error updating settings:', error);
      throw error;
    }
  }

  /**
   * Clear cached settings to force refresh
   */
  clearCache(): void {
    this.cachedSettings = null;
  }

  /**
   * Get contact information
   */
  async getContactInfo(): Promise<{
    supportEmail: string;
    supportPhone: string;
    whatsappNumber: string;
    bugReportFormUrl: string;
  }> {
    const settings = await this.getSettings();
    return {
      supportEmail: settings.supportEmail,
      supportPhone: settings.supportPhone,
      whatsappNumber: settings.whatsappNumber,
      bugReportFormUrl: settings.bugReportFormUrl
    };
  }

  /**
   * Get comprehensive app information
   */
  async getAppInfo(): Promise<AppSettings['appInfo']> {
    const settings = await this.getSettings();
    return settings.appInfo;
  }

  /**
   * Get support information
   */
  async getSupportInfo(): Promise<AppSettings['supportInfo']> {
    const settings = await this.getSettings();
    return settings.supportInfo;
  }
}

export const settingsService = new SettingsService();
