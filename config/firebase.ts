import { logger } from '@/lib/logger';
import { initializeApp } from 'firebase/app';
import { getDatabase } from 'firebase/database';
import { getAuth, initializeAuth } from 'firebase/auth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getStorage } from 'firebase/storage';
import { getFirestore } from 'firebase/firestore';
import { getMessaging, isSupported } from 'firebase/messaging';
import { Platform } from 'react-native';

const firebaseConfig = {
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
  databaseURL: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL,
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};

// (Removed verbose firebase config debug logs to avoid leaking keys in console)

// Initialize Firebase
const app = initializeApp(firebaseConfig);

let auth: import('firebase/auth').Auth;

// Import getReactNativePersistence dynamically to avoid import errors
let getReactNativePersistence: any;

try {
  if (Platform.OS !== 'web') {
    // Dynamically import the persistence function
    getReactNativePersistence = require('firebase/auth').getReactNativePersistence;
  }
} catch (error) {
  logger.warn('Failed to load getReactNativePersistence:', error);
}

if (Platform.OS === 'web') {
  // Web
  auth = getAuth(app);
} else {
  // React Native (iOS/Android)
  try {
    if (getReactNativePersistence) {
      auth = initializeAuth(app, {
        persistence: getReactNativePersistence(AsyncStorage)
      });
    } else {
      // Fallback to regular auth if persistence import fails
      auth = getAuth(app);
    }
  } catch (error) {
    logger.warn('Failed to initialize auth with persistence, falling back to default:', error);
    auth = getAuth(app);
  }
}

export { auth };

// Initialize Firebase services
export const database = getDatabase(app);
export const storage = getStorage(app);
export const firestore = getFirestore(app);

// (Removed storage initialization debug logs for production cleanliness)

// Export Firebase readiness check
export const isFirebaseReady = () => {
  try {
    return !!(app && auth && firestore && firebaseConfig.projectId);
  } catch (error) {
    logger.error('Firebase not ready:', error);
    return false;
  }
};

// Export a function to get messaging instead of initializing at module level
export const getFirebaseMessaging = async () => {
  const supported = await isSupported();
  return supported ? getMessaging(app) : null;
};

export default app;