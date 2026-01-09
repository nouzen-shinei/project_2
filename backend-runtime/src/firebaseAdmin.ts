import fs from 'fs';
import path from 'path';
import * as admin from 'firebase-admin';

let firebaseInited = false;
let firebaseUsedServiceAccount = false;
let firestoreIgnoreUndefinedApplied = false;

function applyFirestoreSettings(): void {
  if (firestoreIgnoreUndefinedApplied) return;
  try {
    // Prevent Firestore from rejecting writes containing `undefined` anywhere in the payload.
    // (This avoids production 500s when optional fields like actorEmail are missing.)
    admin.firestore().settings({ ignoreUndefinedProperties: true });
    firestoreIgnoreUndefinedApplied = true;
  } catch {
    // If Firestore has already been used, settings() may throw. In that case,
    // callers should still defensively strip undefined where needed.
  }
}

/**
 * Ensures the Firebase Admin SDK is initialized exactly once.
 * Reuses the existing app unless a service account becomes available later.
 */
function resolveDatabaseUrl(candidateProjectId?: string, credentialObject?: Record<string, any>): string | undefined {
  const envCandidates = [
    process.env.FIREBASE_DATABASE_URL,
    process.env.FIREBASE_DB_URL,
    process.env.FIREBASE_RTDB_URL,
    process.env.EXPO_PUBLIC_FIREBASE_DATABASE_URL,
  ]
    .map((value) => (value ?? '').trim())
    .filter(Boolean);

  if (envCandidates.length > 0) {
    return envCandidates[0];
  }

  const serviceAccountUrl = credentialObject?.databaseURL || credentialObject?.database_url;
  if (typeof serviceAccountUrl === 'string' && serviceAccountUrl.trim()) {
    return serviceAccountUrl.trim();
  }

  if (candidateProjectId) {
    const project = candidateProjectId.trim();
    if (project) {
      // Prefer modern RTDB host; callers can override via env if region-specific host is required.
      return `https://${project}-default-rtdb.firebaseio.com`;
    }
  }

  return undefined;
}

function resolveStorageBucket(candidateProjectId?: string, credentialObject?: Record<string, any>): string | undefined {
  const envCandidates = [
    process.env.FIREBASE_STORAGE_BUCKET,
    process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET,
  ]
    .map((value) => (value ?? '').trim())
    .filter(Boolean);

  if (envCandidates.length > 0) {
    return envCandidates[0];
  }

  const fromCredential = credentialObject?.storageBucket || credentialObject?.storage_bucket;
  if (typeof fromCredential === 'string' && fromCredential.trim()) {
    return fromCredential.trim();
  }

  if (candidateProjectId) {
    const project = candidateProjectId.trim();
    if (project) {
      return `${project}.appspot.com`;
    }
  }

  return undefined;
}

export function ensureFirebase(): void {
  const projectIdEnv = process.env.FIREBASE_PROJECT_ID || process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
  const serviceAccountPathEnv = process.env.FIREBASE_SERVICE_ACCOUNT_FILE || process.env.FIREBASE_SERVICE_ACCOUNT_PATH;

  let serviceAccountRaw: string | undefined;
  const candidatePaths = [serviceAccountPathEnv, path.resolve(__dirname, '../firebase_sa.b64')]
    .map(p => (p ?? '').trim())
    .filter(Boolean);

  for (const candidate of candidatePaths) {
    try {
      if (fs.existsSync(candidate)) {
        serviceAccountRaw = fs.readFileSync(candidate, 'utf8').trim();
        if (serviceAccountRaw) break;
      }
    } catch {
      // ignore file system issues; we'll try the next source
    }
  }

  if (!serviceAccountRaw) {
    serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  }

  if (firebaseInited && serviceAccountRaw && !firebaseUsedServiceAccount) {
    try {
      admin.app().delete().catch(() => undefined);
      firebaseInited = false;
    } catch {
      // ignore delete errors; we'll attempt re-init below
    }
  }

  if (firebaseInited) {
    applyFirestoreSettings();
    return;
  }

  if (admin.apps.length === 0) {
    let projectId = projectIdEnv;
    let databaseURL: string | undefined;
    let storageBucket: string | undefined;
    if (serviceAccountRaw) {
      try {
        const jsonStr = serviceAccountRaw.trim().startsWith('{')
          ? serviceAccountRaw
          : Buffer.from(serviceAccountRaw, 'base64').toString('utf8');
        const credentialObject = JSON.parse(jsonStr) as Record<string, any>;
        projectId = projectId || (credentialObject as any)?.project_id;
        databaseURL = resolveDatabaseUrl(projectId, credentialObject);
        storageBucket = resolveStorageBucket(projectId, credentialObject);

        const appOptions: admin.AppOptions = {
          credential: admin.credential.cert(credentialObject as admin.ServiceAccount),
          projectId,
        };

        if (databaseURL) {
          appOptions.databaseURL = databaseURL;
        }
        if (storageBucket) {
          appOptions.storageBucket = storageBucket;
        }

        admin.initializeApp(appOptions);
        firebaseUsedServiceAccount = true;
      } catch {
        try {
          databaseURL = resolveDatabaseUrl(projectId);
          storageBucket = resolveStorageBucket(projectId);
          const appOptions: admin.AppOptions = {
            credential: admin.credential.applicationDefault(),
            projectId,
          };
          if (databaseURL) {
            appOptions.databaseURL = databaseURL;
          }
          if (storageBucket) {
            appOptions.storageBucket = storageBucket;
          }
          admin.initializeApp(appOptions);
        } catch {
          databaseURL = resolveDatabaseUrl(projectId);
          storageBucket = resolveStorageBucket(projectId);
          const appOptions: admin.AppOptions = { projectId };
          if (databaseURL) {
            appOptions.databaseURL = databaseURL;
          }
          if (storageBucket) {
            appOptions.storageBucket = storageBucket;
          }
          admin.initializeApp(appOptions);
        }
      }
    } else {
      try {
        const databaseURL = resolveDatabaseUrl(projectId);
        const storageBucket = resolveStorageBucket(projectId);
        const appOptions: admin.AppOptions = {
          credential: admin.credential.applicationDefault(),
          projectId,
        };
        if (databaseURL) {
          appOptions.databaseURL = databaseURL;
        }
        if (storageBucket) {
          appOptions.storageBucket = storageBucket;
        }
        admin.initializeApp(appOptions);
      } catch {
        const databaseURL = resolveDatabaseUrl(projectId);
        const storageBucket = resolveStorageBucket(projectId);
        const appOptions: admin.AppOptions = { projectId };
        if (databaseURL) {
          appOptions.databaseURL = databaseURL;
        }
        if (storageBucket) {
          appOptions.storageBucket = storageBucket;
        }
        admin.initializeApp(appOptions);
      }
    }
  }

  applyFirestoreSettings();
  firebaseInited = true;
}

export function getFirestore(): admin.firestore.Firestore {
  ensureFirebase();
  return admin.firestore();
}

export function resetFirebaseForTests(): void {
  try {
    admin.app().delete().catch(() => undefined);
  } catch {
    // ignore
  }
  firebaseInited = false;
  firebaseUsedServiceAccount = false;
}
