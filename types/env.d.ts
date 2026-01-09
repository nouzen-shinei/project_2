declare global {
  namespace NodeJS {
    interface ProcessEnv {
      // Firebase
      EXPO_PUBLIC_FIREBASE_API_KEY: string;
      EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN: string;
      EXPO_PUBLIC_FIREBASE_DATABASE_URL: string;
      EXPO_PUBLIC_FIREBASE_PROJECT_ID: string;
      EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET: string;
      EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: string;
      EXPO_PUBLIC_FIREBASE_APP_ID: string;

      // Google OAuth
      EXPO_PUBLIC_GOOGLE_CLIENT_ID: string;
      EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID: string;
      EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID: string;

      // Backend base URLs
      EXPO_PUBLIC_API_BASE_URL?: string;
      EXPO_PUBLIC_EMAIL_API_BASE_URL?: string;

      // Twilio
  // (Removed) Twilio credentials now server-side only
  // Free-plan flags removed

      // WhatsApp Business API
      EXPO_PUBLIC_WHATSAPP_API_URL: string;
      EXPO_PUBLIC_WHATSAPP_API_TOKEN: string;
      EXPO_PUBLIC_WABA_API_BASE_URL?: string;
      EXPO_PUBLIC_WABA_PHONE_NUMBER_ID?: string;
      EXPO_PUBLIC_WABA_ACCESS_TOKEN?: string; // dev-only, avoided in prod

      // Internal auth/debug flags
      EXPO_PUBLIC_DEBUG_AUTH?: string; // '1' | 'true' to enable extra logs
      EXPO_PUBLIC_INTERNAL_TOKEN_DEV_SECRET?: string; // dev bridging secret if used
    }
  }
}

export {};