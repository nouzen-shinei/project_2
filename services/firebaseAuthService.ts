import { logger } from '@/lib/logger';
// Alternative Google OAuth implementation using Firebase Auth built-in provider
// This avoids the PKCE complexity by using Firebase's managed OAuth flow

import { auth, firestore } from '@/config/firebase';
import { 
  signInWithPopup,
  GoogleAuthProvider,
  signOut as firebaseSignOut,
  onAuthStateChanged,
} from 'firebase/auth';
import { doc, getDoc, setDoc, collection, getDocs, deleteDoc } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';

export interface AuthUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  isAuthorized: boolean;
  isBypass?: boolean;
}

class FirebaseAuthService {
  private authorizedEmails: string[] = [];
  private currentUser: AuthUser | null = null;

  constructor() {
    // Don't load authorized emails immediately - wait for authentication
    // this.loadAuthorizedEmails(); // Commented out to prevent permission errors
    this.initializeAuthListener();
  }

  private async loadAuthorizedEmails(): Promise<void> {
    try {
      // Check if user is authenticated before making Firestore calls
      if (!auth.currentUser) {
        logger.debug('FirebaseAuthService: No authenticated user, skipping Firestore query');
        // Load from AsyncStorage as fallback
        const stored = await AsyncStorage.getItem('authorizedEmails');
        if (stored) {
          this.authorizedEmails = JSON.parse(stored);
        } else {
          this.authorizedEmails = [];
        }
        return;
      }

      // Load from Firestore collection where each email is a separate document
      const authCollection = collection(firestore, 'authorizedEmails');
      const querySnapshot = await getDocs(authCollection);
      
      if (!querySnapshot.empty) {
        this.authorizedEmails = [];
        querySnapshot.forEach((doc) => {
          const data = doc.data();
          if (data.email) {
            this.authorizedEmails.push(data.email.toLowerCase());
          }
        });
        logger.debug('Loaded authorized emails from Firestore:', this.authorizedEmails);
      } else {
        // Fallback to AsyncStorage for backward compatibility
        const stored = await AsyncStorage.getItem('authorizedEmails');
        if (stored) {
          this.authorizedEmails = JSON.parse(stored);
        } else {
          this.authorizedEmails = [];
        }
        // Save to Firestore for future use
        await this.saveAuthorizedEmails();
      }
    } catch (error) {
      logger.error('Error loading authorized emails:', error);
  this.authorizedEmails = [];
    }
  }

  private async saveAuthorizedEmails(): Promise<void> {
    try {
      // Save each email as a separate document in the authorizedEmails collection
      const authCollection = collection(firestore, 'authorizedEmails');
      
      // First, get existing docs to clean up removed emails
      const existingDocs = await getDocs(authCollection);
      const existingEmails = new Set<string>();
      existingDocs.forEach((docSnap) => {
        const data = docSnap.data();
        if (data.email) {
          existingEmails.add(data.email.toLowerCase());
        }
      });
      
      // Remove emails that are no longer authorized
      for (const email of existingEmails) {
        if (!this.authorizedEmails.includes(email)) {
          const docId = email.replace(/[@.]/g, '_');
          await deleteDoc(doc(firestore, 'authorizedEmails', docId));
        }
      }
      
      // Add/update current authorized emails
      for (const email of this.authorizedEmails) {
        const docId = email.replace(/[@.]/g, '_'); // Convert email to valid doc ID
        const emailDoc = doc(firestore, 'authorizedEmails', docId);
        await setDoc(emailDoc, {
          email: email,
          addedAt: new Date(),
          addedBy: auth.currentUser?.email || 'system',
          isActive: true
        }, { merge: true });
      }
      
      // Also save to AsyncStorage for offline access
      await AsyncStorage.setItem('authorizedEmails', JSON.stringify(this.authorizedEmails));
      logger.debug('Saved authorized emails to Firestore');
    } catch (error) {
      logger.error('Error saving authorized emails:', error);
    }
  }

  private initializeAuthListener(): void {
    onAuthStateChanged(auth, async (user) => {
      if (user) {
        // Load authorized emails now that user is authenticated
        await this.loadAuthorizedEmails();
        
        this.currentUser = {
          uid: user.uid,
          email: user.email || '',
          displayName: user.displayName || '',
          photoURL: user.photoURL || undefined,
          isAuthorized: true,
        };
      } else {
        this.currentUser = null;
      }
    });
  }

  async signInWithGoogle(): Promise<{ success: boolean; user?: AuthUser; error?: string }> {
    try {
      logger.debug('Starting Firebase Google Sign-In...');
      
      // Create Google Auth Provider
      const provider = new GoogleAuthProvider();
      provider.addScope('profile');
      provider.addScope('email');
      
      // Use Firebase's built-in popup sign-in (handles OAuth complexity)
      const result = await signInWithPopup(auth, provider);
      const firebaseUser = result.user;
      
      logger.debug('Firebase sign-in successful:', firebaseUser.email);
      
      const authUser: AuthUser = {
        uid: firebaseUser.uid,
        email: firebaseUser.email || '',
        displayName: firebaseUser.displayName || 'User',
        photoURL: firebaseUser.photoURL || undefined,
        isAuthorized: true,
      };

      this.currentUser = authUser;
      router.replace('/(tabs)');

      return {
        success: true,
        user: authUser,
      };
    } catch (error) {
      logger.error('Firebase Google Sign-In error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Google Sign-In failed',
      };
    }
  }

  async signOut(): Promise<void> {
    try {
      await firebaseSignOut(auth);
      this.currentUser = null;
      await AsyncStorage.multiRemove(['userProfile', 'appSettings']);
      router.replace('/auth/login');
    } catch (error) {
      logger.error('Sign out error:', error);
    }
  }

  getCurrentUser(): AuthUser | null {
    return this.currentUser;
  }

  isAuthenticated(): boolean {
    return this.currentUser !== null;
  }

  onAuthStateChange(callback: (user: AuthUser | null) => void): () => void {
    return onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        const authUser: AuthUser = {
          uid: firebaseUser.uid,
          email: firebaseUser.email || '',
          displayName: firebaseUser.displayName || '',
          photoURL: firebaseUser.photoURL || undefined,
          isAuthorized: true,
        };
        callback(authUser);
      } else {
        callback(null);
      }
    });
  }

  // Email management methods
  async getAuthorizedEmails(): Promise<string[]> {
    // Reload from Firestore to get latest
    await this.loadAuthorizedEmails();
    return [...this.authorizedEmails];
  }

  async addAuthorizedEmail(email: string): Promise<void> {
    if (!this.authorizedEmails.includes(email.toLowerCase())) {
      this.authorizedEmails.push(email.toLowerCase());
      await this.saveAuthorizedEmails();
    }
  }

  async removeAuthorizedEmail(email: string): Promise<void> {
    this.authorizedEmails = this.authorizedEmails.filter(
      e => e !== email.toLowerCase()
    );
    await this.saveAuthorizedEmails();
  }

  async updateAuthorizedEmails(emails: string[]): Promise<void> {
    this.authorizedEmails = emails.map(email => email.toLowerCase());
    await this.saveAuthorizedEmails();
  }
}

export const firebaseAuthService = new FirebaseAuthService();
export default firebaseAuthService;
