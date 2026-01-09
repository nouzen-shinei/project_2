import { logger } from '@/lib/logger';
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFirebaseMessaging = exports.isFirebaseReady = exports.firestore = exports.storage = exports.database = exports.auth = void 0;
const app_1 = require("firebase/app");
const database_1 = require("firebase/database");
const auth_1 = require("firebase/auth");
const async_storage_1 = __importDefault(require("@react-native-async-storage/async-storage"));
const storage_1 = require("firebase/storage");
const firestore_1 = require("firebase/firestore");
const messaging_1 = require("firebase/messaging");
const react_native_1 = require("react-native");
const firebaseConfig = {
    apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL,
    projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID,
};
// (Removed verbose firebase config debug logs)
// In Jest test environment, provide a minimal mock to avoid needing real API keys
const isTest = process.env.NODE_ENV === 'test';
const app = isTest ? { options: firebaseConfig } : (0, app_1.initializeApp)(firebaseConfig);
let auth;
// Import getReactNativePersistence dynamically to avoid import errors
let getReactNativePersistence;
try {
    if (react_native_1.Platform.OS !== 'web') {
        // Dynamically import the persistence function
        getReactNativePersistence = require('firebase/auth').getReactNativePersistence;
    }
}
catch (error) {
    logger.warn('Failed to load getReactNativePersistence:', error);
}
if (isTest) {
    exports.auth = auth = { mock: true };
}
else if (react_native_1.Platform.OS === 'web') {
    // Web
    exports.auth = auth = (0, auth_1.getAuth)(app);
}
else {
    // React Native (iOS/Android)
    try {
        if (getReactNativePersistence) {
            exports.auth = auth = (0, auth_1.initializeAuth)(app, {
                persistence: getReactNativePersistence(async_storage_1.default)
            });
        }
        else {
            // Fallback to regular auth if persistence import fails
            exports.auth = auth = (0, auth_1.getAuth)(app);
        }
    }
    catch (error) {
        logger.warn('Failed to initialize auth with persistence, falling back to default:', error);
        exports.auth = auth = (0, auth_1.getAuth)(app);
    }
}
// Initialize Firebase services
exports.database = isTest ? {} : (0, database_1.getDatabase)(app);
exports.storage = isTest ? { app } : (0, storage_1.getStorage)(app);
exports.firestore = isTest ? {} : (0, firestore_1.getFirestore)(app);
// (Removed storage initialization debug logs)
// Export Firebase readiness check
const isFirebaseReady = () => {
    try {
        return !!(app && auth && exports.firestore && firebaseConfig.projectId);
    }
    catch (error) {
        logger.error('Firebase not ready:', error);
        return false;
    }
};
exports.isFirebaseReady = isFirebaseReady;
// Export a function to get messaging instead of initializing at module level
const getFirebaseMessaging = async () => {
    if (isTest)
        return null;
    const supported = await (0, messaging_1.isSupported)();
    return supported ? (0, messaging_1.getMessaging)(app) : null;
};
exports.getFirebaseMessaging = getFirebaseMessaging;
exports.default = app;
//# sourceMappingURL=firebase.js.map