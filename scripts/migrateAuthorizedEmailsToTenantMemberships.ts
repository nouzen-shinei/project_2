#!/usr/bin/env ts-node
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { initializeApp, applicationDefault, cert } from 'firebase-admin/app';
import {
  getFirestore,
  FieldPath,
  FieldValue,
  type Firestore,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';

interface ScriptOptions {
  tenantId: string;
  batchSize: number;
  limit: number;
  resumeAfter?: string;
  dryRun: boolean;
  credentialsPath?: string;
  legacyCollection: string;
  profileCollection: string;
  presenceCollection: string;
  includeProfiles: boolean;
  includePresence: boolean;
  logFile?: string;
  defaultRole: 'staff' | 'member';
}

interface MigrationStats {
  scanned: number;
  migrated: number;
  skipped: number;
  membershipCreated: number;
  membershipUpdated: number;
  profileUpserts: number;
  presenceUpserts: number;
  errors: number;
}

interface DocumentResult {
  status: 'migrated' | 'skipped' | 'error';
  reason?: string;
  docId: string;
  email?: string;
  membershipAction?: 'created' | 'updated';
  profileAction?: 'skipped' | 'upserted';
  presenceAction?: 'skipped' | 'upserted';
}

const DEFAULT_LEGACY_COLLECTION = 'authorizedEmails';
const DEFAULT_PROFILE_COLLECTION = 'tenantProfiles';
const DEFAULT_PRESENCE_COLLECTION = 'tenantPresence';

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    tenantId: 'legacy-coaching',
    batchSize: 200,
    limit: Number.POSITIVE_INFINITY,
    resumeAfter: undefined,
    dryRun: !argv.includes('--commit'),
    credentialsPath: undefined,
    legacyCollection: DEFAULT_LEGACY_COLLECTION,
    profileCollection: DEFAULT_PROFILE_COLLECTION,
    presenceCollection: DEFAULT_PRESENCE_COLLECTION,
    includeProfiles: true,
    includePresence: true,
    logFile: undefined,
    defaultRole: 'staff',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--tenant':
        options.tenantId = argv[i + 1] || options.tenantId;
        i += 1;
        break;
      case '--batch':
      case '--batch-size':
        options.batchSize = Math.max(1, Number(argv[i + 1]) || options.batchSize);
        i += 1;
        break;
      case '--limit':
        options.limit = Math.max(1, Number(argv[i + 1]) || options.limit);
        i += 1;
        break;
      case '--resume':
      case '--resume-after':
        options.resumeAfter = argv[i + 1];
        i += 1;
        break;
      case '--credentials':
        options.credentialsPath = argv[i + 1];
        i += 1;
        break;
      case '--legacy-collection':
        options.legacyCollection = argv[i + 1] || options.legacyCollection;
        i += 1;
        break;
      case '--profile-collection':
        options.profileCollection = argv[i + 1] || options.profileCollection;
        i += 1;
        break;
      case '--presence-collection':
        options.presenceCollection = argv[i + 1] || options.presenceCollection;
        i += 1;
        break;
      case '--log-file':
        options.logFile = argv[i + 1];
        i += 1;
        break;
      case '--skip-profiles':
        options.includeProfiles = false;
        break;
      case '--skip-presence':
        options.includePresence = false;
        break;
      case '--default-role': {
        const role = (argv[i + 1] || '').toLowerCase();
        if (role === 'member' || role === 'staff') {
          options.defaultRole = role;
        }
        i += 1;
        break;
      }
      default:
        break;
    }
  }

  return options;
}

function resolveCredentialContent(credentialsPath?: string): any | undefined {
  if (!credentialsPath) {
    return undefined;
  }
  const resolved = credentialsPath.startsWith('.')
    ? path.resolve(process.cwd(), credentialsPath)
    : credentialsPath;
  if (!fs.existsSync(resolved)) {
    throw new Error(`Credentials file not found at ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function initFirestore(credentialsPath?: string): Firestore {
  const alreadyInitialized = (global as unknown as { __authorizedEmailsMigration?: boolean })
    .__authorizedEmailsMigration;
  if (!alreadyInitialized) {
    const options: Parameters<typeof initializeApp>[0] = {};
    const credentialContent = resolveCredentialContent(credentialsPath);
    if (credentialContent) {
      options.credential = cert(credentialContent);
    } else {
      try {
        options.credential = applicationDefault();
      } catch (error) {
        console.warn('[authorized-email-migration] falling back to unauthenticated admin SDK init:', (error as Error).message);
      }
    }
    initializeApp(options);
    (global as unknown as { __authorizedEmailsMigration?: boolean }).__authorizedEmailsMigration = true;
  }
  return getFirestore();
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
}

function sanitizeEmailKey(email: string): string {
  return email.replace(/[@.]/g, '_');
}

function mapRole(role: unknown, defaultRole: 'staff' | 'member'): 'owner' | 'admin' | 'staff' | 'member' {
  const normalized = typeof role === 'string' ? role.trim().toLowerCase() : '';
  if (!normalized) {
    return defaultRole;
  }
  if (normalized === 'owner') return 'owner';
  if (normalized === 'admin' || normalized === 'superadmin') return 'admin';
  if (normalized === 'staff' || normalized === 'teacher' || normalized === 'coach') return 'staff';
  return defaultRole;
}

const PROFILE_FIELD_KEYS = [
  'displayName',
  'name',
  'dateOfBirth',
  'birthdayNotificationsOptOut',
  'birthdayLanguagePreference',
  'salutation',
  'labels',
  'gender',
  'coachingName',
  'notes',
  'lastBirthdayNotificationDateKey',
  'lastBirthdayNotificationSentAt',
  'lastBirthdayNotificationAttemptedAt',
  'lastBirthdayNotificationAttemptedDateKey',
  'lastBirthdayNotificationAttemptedTokenCount',
  'lastBirthdayNotificationDeliveredCount',
  'lastBirthdayNotificationFailedCount',
  'lastBirthdayNotificationSuccessCount',
  'whatsappNumber',
  'phone',
  'phoneNumber',
  'contactNumber',
  'mobile',
  'mobileNumber',
];

const WHATSAPP_FIELD_KEYS = [
  'whatsappNumber',
  'phone',
  'phoneNumber',
  'contactNumber',
  'mobile',
  'mobileNumber',
  'whatsapp',
];

const PRESENCE_FIELD_KEYS = [
  'isOnline',
  'lastSeen',
  'lastHeartbeatAt',
  'lastHeartbeatTenantId',
  'lastHeartbeatClient',
  'presenceSource',
  'lastPresenceUpdateAt',
];

function pickFields(source: Record<string, any>, keys: string[]): Record<string, any> {
  const target: Record<string, any> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      target[key] = source[key];
    }
  }
  return target;
}

function createLogStream(filePath?: string): fs.WriteStream | null {
  if (!filePath) {
    return null;
  }
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return fs.createWriteStream(resolved, { flags: 'a' });
}

async function migrateDocument(
  doc: QueryDocumentSnapshot,
  db: Firestore,
  options: ScriptOptions
): Promise<DocumentResult> {
  const data = doc.data() as Record<string, any>;
  const normalizedEmail = normalizeEmail(data.email) || normalizeEmail(doc.get('email'));
  if (!normalizedEmail) {
    return { status: 'skipped', reason: 'missing_email', docId: doc.id };
  }

  const userIdRaw = typeof data.userId === 'string' ? data.userId.trim() : '';
  const uidRaw = typeof data.uid === 'string' ? data.uid.trim() : '';
  const membershipUserId = userIdRaw || uidRaw || sanitizeEmailKey(normalizedEmail);
  const membershipDocId = `${options.tenantId}_${membershipUserId}`;
  const membershipRef = db.collection('tenantMemberships').doc(membershipDocId);
  const membershipSnap = await membershipRef.get();
  const membershipRole = mapRole(data.role, options.defaultRole);
  const nowTimestamp = FieldValue.serverTimestamp();
  const displayName = typeof data.displayName === 'string' && data.displayName.trim()
    ? data.displayName.trim()
    : typeof data.name === 'string' && data.name.trim()
    ? data.name.trim()
    : normalizedEmail.split('@')[0];

  const membershipPayload: Record<string, any> = {
    tenantId: options.tenantId,
    userId: membershipUserId,
    email: normalizedEmail,
    role: membershipRole,
    status: 'active',
    displayName,
    source: 'authorizedEmailsMigration',
    legacyAuthorizedEmailDocId: doc.id,
    legacyAuthorizedEmailRole: typeof data.role === 'string' ? data.role : undefined,
    migratedAt: nowTimestamp,
    updatedAt: nowTimestamp,
  };

  if (!membershipSnap.exists) {
    membershipPayload.createdAt = nowTimestamp;
  }

  let membershipAction: 'created' | 'updated' = membershipSnap.exists ? 'updated' : 'created';

  if (!options.dryRun) {
    await membershipRef.set(membershipPayload, { merge: true });
  }

  let profileAction: 'skipped' | 'upserted' = 'skipped';
  if (options.includeProfiles) {
    const profileFields = pickFields(data, PROFILE_FIELD_KEYS);
    const primaryWhatsapp = findPrimaryWhatsapp(data);
    if (primaryWhatsapp) {
      profileFields.whatsappNumber = primaryWhatsapp.value;
      profileFields.primaryWhatsappField = primaryWhatsapp.field;
    }
    const cleanedProfileFields = cleanupEmptyFields(profileFields);
    if (Object.keys(cleanedProfileFields).length > 0) {
      const profileDocId = `${options.tenantId}_${sanitizeEmailKey(normalizedEmail)}`;
      const profileRef = db.collection(options.profileCollection).doc(profileDocId);
      const profilePayload: Record<string, any> = {
        tenantId: options.tenantId,
        email: normalizedEmail,
        membershipUserId,
        legacyAuthorizedEmailDocId: doc.id,
        source: 'authorizedEmailsMigration',
        updatedAt: nowTimestamp,
        ...cleanedProfileFields,
      };
      if (!options.dryRun) {
        await profileRef.set(profilePayload, { merge: true });
      }
      profileAction = 'upserted';
    }
  }

  let presenceAction: 'skipped' | 'upserted' = 'skipped';
  if (options.includePresence) {
    const presenceFields = cleanupEmptyFields(pickFields(data, PRESENCE_FIELD_KEYS));
    if (Object.keys(presenceFields).length > 0) {
      const presenceDocId = `${options.tenantId}_${sanitizeEmailKey(normalizedEmail)}`;
      const presenceRef = db.collection(options.presenceCollection).doc(presenceDocId);
      const presencePayload: Record<string, any> = {
        tenantId: options.tenantId,
        email: normalizedEmail,
        membershipUserId,
        source: 'authorizedEmailsMigration',
        updatedAt: nowTimestamp,
        ...presenceFields,
      };
      if (!options.dryRun) {
        await presenceRef.set(presencePayload, { merge: true });
      }
      presenceAction = 'upserted';
    }
  }

  return {
    status: 'migrated',
    docId: doc.id,
    email: normalizedEmail,
    membershipAction,
    profileAction,
    presenceAction,
  };
}

function cleanupEmptyFields(input: Record<string, any>): Record<string, any> {
  const output: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'string' && !value.trim()) {
      continue;
    }
    if (value && typeof value === 'object' && Object.keys(value).length === 0) {
      continue;
    }
    output[key] = value;
  }
  return output;
}

function findPrimaryWhatsapp(source: Record<string, any>): { field: string; value: string } | null {
  for (const key of WHATSAPP_FIELD_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return { field: key, value: value.trim() };
    }
  }
  return null;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const firestore = initFirestore(options.credentialsPath);
  const stats: MigrationStats = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    membershipCreated: 0,
    membershipUpdated: 0,
    profileUpserts: 0,
    presenceUpserts: 0,
    errors: 0,
  };

  const logStream = createLogStream(options.logFile);
  const log = (entry: Record<string, any>): void => {
    if (logStream) {
      logStream.write(`${JSON.stringify(entry)}\n`);
    }
  };

  console.log('[authorized-email-migration] starting');
  console.log('  tenantId:', options.tenantId);
  console.log('  legacyCollection:', options.legacyCollection);
  console.log('  batchSize:', options.batchSize);
  console.log('  dryRun:', options.dryRun ? 'yes' : 'no');

  const legacyCol = firestore.collection(options.legacyCollection);
  let lastDoc: QueryDocumentSnapshot | null = null;
  let shouldContinue = true;

  if (options.resumeAfter) {
    try {
      const resumeSnap = await legacyCol.doc(options.resumeAfter).get();
      if (resumeSnap.exists) {
        lastDoc = resumeSnap as QueryDocumentSnapshot;
        console.log(`[authorized-email-migration] resuming after ${options.resumeAfter}`);
      } else {
        console.warn(`[authorized-email-migration] resume doc ${options.resumeAfter} not found; starting from beginning`);
      }
    } catch (error) {
      console.warn('[authorized-email-migration] failed to load resume doc', error);
    }
  }

  while (shouldContinue && stats.scanned < options.limit) {
    let query = legacyCol.orderBy(FieldPath.documentId()).limit(options.batchSize);
    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      break;
    }

    lastDoc = snapshot.docs[snapshot.docs.length - 1];

    for (const doc of snapshot.docs) {
      if (stats.scanned >= options.limit) {
        shouldContinue = false;
        break;
      }

      stats.scanned += 1;
      try {
        const result = await migrateDocument(doc, firestore, options);
        log({
          ...result,
          dryRun: options.dryRun,
          timestamp: new Date().toISOString(),
        });
        if (result.status === 'migrated') {
          stats.migrated += 1;
          if (result.membershipAction === 'created') {
            stats.membershipCreated += 1;
          } else {
            stats.membershipUpdated += 1;
          }
          if (result.profileAction === 'upserted') {
            stats.profileUpserts += 1;
          }
          if (result.presenceAction === 'upserted') {
            stats.presenceUpserts += 1;
          }
        } else if (result.status === 'skipped') {
          stats.skipped += 1;
        }
      } catch (error) {
        stats.errors += 1;
        console.error('[authorized-email-migration] failed to migrate doc', doc.id, error);
        log({
          status: 'error',
          docId: doc.id,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  if (logStream) {
    await new Promise<void>((resolve) => {
      logStream.end(resolve);
    });
  }

  console.log('\n[authorized-email-migration] complete');
  console.table({
    scanned: stats.scanned,
    migrated: stats.migrated,
    skipped: stats.skipped,
    membershipCreated: stats.membershipCreated,
    membershipUpdated: stats.membershipUpdated,
    profileUpserts: stats.profileUpserts,
    presenceUpserts: stats.presenceUpserts,
    errors: stats.errors,
  });
}

main().catch((error) => {
  console.error('[authorized-email-migration] unexpected failure', error);
  process.exitCode = 1;
});
