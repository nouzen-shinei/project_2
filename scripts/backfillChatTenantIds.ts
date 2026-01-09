#!/usr/bin/env ts-node
import 'dotenv/config';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import type { AppOptions } from 'firebase-admin/app';
import type { database } from 'firebase-admin';

interface ScriptOptions {
  dryRun: boolean;
  limit?: number;
  batchSize: number;
  conversation?: string;
  resumeKey?: string;
  verbose: boolean;
  fallbackTenantId?: string;
}

interface Stats {
  conversationsVisited: number;
  resolved: number;
  skippedNoMessages: number;
  skippedParticipants: number;
  unresolved: number;
  conflicts: number;
  fallbackApplied: number;
  messagesUpdated: number;
  messageIndexUpdated: number;
  conversationLatestUpdated: number;
  conversationSummariesUpdated: number;
  userConversationsUpdated: number;
}

interface ParticipantPair {
  a: string;
  b: string;
  aKey: string;
  bKey: string;
}

interface TenantResolution {
  tenantId: string;
  source: string;
}

interface Context {
  options: ScriptOptions;
  stats: Stats;
  memberships: Map<string, Set<string>>;
  firestore: Firestore;
  db: database.Database;
  refs: {
    conversationLatest: database.Reference;
    conversationMessages: database.Reference;
    conversationSummaries: database.Reference;
    userConversations: database.Reference;
    messageIndex: database.Reference;
  };
}

interface ConversationLatestRecord {
  sender?: string;
  recipientId?: string | null;
  tenantId?: string | null;
}

function normalizeEmail(value?: string | null): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function sanitizeKey(value?: string | null): string | null {
  const normalized = normalizeEmail(value);
  return normalized ? normalized.replace(/[.@]/g, '_') : null;
}

function parseArgs(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    dryRun: argv.includes('--dry-run'),
    limit: undefined,
    batchSize: 25,
    conversation: undefined,
    resumeKey: undefined,
    verbose: argv.includes('--verbose'),
    fallbackTenantId: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--limit':
        options.limit = Number(argv[i + 1]);
        i += 1;
        break;
      case '--batch-size':
      case '--batch':
        options.batchSize = Number(argv[i + 1]) || options.batchSize;
        i += 1;
        break;
      case '--conversation':
        options.conversation = argv[i + 1];
        i += 1;
        break;
      case '--resume':
        options.resumeKey = argv[i + 1];
        i += 1;
        break;
      case '--fallback-tenant':
      case '--tenant':
        options.fallbackTenantId = argv[i + 1];
        i += 1;
        break;
      default:
        break;
    }
  }

  return options;
}

function buildStats(): Stats {
  return {
    conversationsVisited: 0,
    resolved: 0,
    skippedNoMessages: 0,
    skippedParticipants: 0,
    unresolved: 0,
    conflicts: 0,
    fallbackApplied: 0,
    messagesUpdated: 0,
    messageIndexUpdated: 0,
    conversationLatestUpdated: 0,
    conversationSummariesUpdated: 0,
    userConversationsUpdated: 0,
  };
}

function initFirebase(): void {
  const alreadyInitialized = (global as unknown as { __firebaseInitialized?: boolean }).__firebaseInitialized;
  if (alreadyInitialized) {
    return;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;

  const options: AppOptions = {
    projectId,
    databaseURL,
  };

  try {
    options.credential = applicationDefault();
  } catch (error) {
    console.warn('[init] falling back to default credentials', (error as Error)?.message);
  }

  initializeApp(options);
  (global as unknown as { __firebaseInitialized?: boolean }).__firebaseInitialized = true;
}

async function loadMembershipIndex(store: Firestore): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();
  const snapshot = await store.collection('tenantMemberships').get();
  snapshot.forEach((doc) => {
    const data = doc.data() as { email?: string; tenantId?: string; status?: string };
    const email = normalizeEmail(data.email);
    if (!email || !data.tenantId) {
      return;
    }
    if (data.status && data.status !== 'active') {
      return;
    }
    if (!map.has(email)) {
      map.set(email, new Set());
    }
    map.get(email)?.add(data.tenantId);
  });
  return map;
}

async function loadConversationMessages(ctx: Context, conversationKey: string): Promise<database.DataSnapshot[] | null> {
  const snapshot = await ctx.refs.conversationMessages.child(conversationKey).get();
  if (!snapshot.exists()) {
    return null;
  }
  const nodes: database.DataSnapshot[] = [];
  snapshot.forEach((child) => {
    if (child.key) {
      nodes.push(child);
    }
    return false;
  });
  return nodes;
}

function extractParticipants(messages: database.DataSnapshot[], latest?: ConversationLatestRecord | null): ParticipantPair | null {
  let candidates = new Set<string>();
  if (messages.length > 0) {
    const first = messages[0].val() as { sender?: string; recipientId?: string };
    const sender = normalizeEmail(first?.sender);
    const recipient = normalizeEmail(first?.recipientId);
    if (sender) {
      candidates.add(sender);
    }
    if (recipient) {
      candidates.add(recipient);
    }
  }

  if (latest) {
    const sender = normalizeEmail(latest.sender);
    const recipient = normalizeEmail(latest.recipientId);
    if (sender) {
      candidates.add(sender);
    }
    if (recipient) {
      candidates.add(recipient);
    }
  }

  candidates = new Set([...candidates].filter(Boolean));

  if (candidates.size !== 2) {
    return null;
  }

  const [a, b] = [...candidates].sort();
  const aKey = sanitizeKey(a);
  const bKey = sanitizeKey(b);
  if (!aKey || !bKey) {
    return null;
  }

  return { a, b, aKey, bKey };
}

function tenantSetToArray(set?: Set<string>): string[] {
  return set ? Array.from(set) : [];
}

function resolveFromMemberships(ctx: Context, participants: ParticipantPair): TenantResolution | null {
  const tenantsA = tenantSetToArray(ctx.memberships.get(participants.a));
  const tenantsB = tenantSetToArray(ctx.memberships.get(participants.b));

  const intersection = tenantsA.filter((tenant) => tenantsB.includes(tenant));
  if (intersection.length === 1) {
    return { tenantId: intersection[0], source: 'membership:shared' };
  }

  if (tenantsA.length === 1 && tenantsB.length === 0) {
    return { tenantId: tenantsA[0], source: 'membership:a-only' };
  }

  if (tenantsB.length === 1 && tenantsA.length === 0) {
    return { tenantId: tenantsB[0], source: 'membership:b-only' };
  }

  return null;
}

async function fetchSnapshot(ref: database.Reference): Promise<database.DataSnapshot | null> {
  const snapshot = await ref.get();
  return snapshot.exists() ? snapshot : null;
}

async function determineTenantId(
  ctx: Context,
  conversationKey: string,
  latest: ConversationLatestRecord | null,
  participants: ParticipantPair,
  userConversationSnapshots: { a: database.DataSnapshot | null; b: database.DataSnapshot | null },
  summarySnapshots: { ab: database.DataSnapshot | null; ba: database.DataSnapshot | null }
): Promise<TenantResolution | null> {
  const candidates = new Map<string, Set<string>>();

  const pushCandidate = (value: unknown, source: string) => {
    if (typeof value !== 'string' || !value.trim()) {
      return;
    }
    const normalized = value.trim();
    if (!candidates.has(normalized)) {
      candidates.set(normalized, new Set());
    }
    candidates.get(normalized)?.add(source);
  };

  pushCandidate(latest?.tenantId, 'conversationLatest');
  pushCandidate(userConversationSnapshots.a?.val()?.tenantId, `userConversations:${participants.a}`);
  pushCandidate(userConversationSnapshots.b?.val()?.tenantId, `userConversations:${participants.b}`);
  pushCandidate(summarySnapshots.ab?.val()?.tenantId, `conversationSummaries:${participants.a}`);
  pushCandidate(summarySnapshots.ba?.val()?.tenantId, `conversationSummaries:${participants.b}`);

  if (candidates.size === 1) {
    const [[tenantId, sourceSet]] = Array.from(candidates.entries());
    return { tenantId, source: Array.from(sourceSet).join(',') };
  }

  if (candidates.size > 1) {
    ctx.stats.conflicts += 1;
    console.warn(`[${conversationKey}] conflicting tenant candidates: ${Array.from(candidates.keys()).join(', ')}`);
    return null;
  }

  return resolveFromMemberships(ctx, participants);
}

async function backfillConversation(
  ctx: Context,
  conversationKey: string
): Promise<void> {
  ctx.stats.conversationsVisited += 1;

  const messages = await loadConversationMessages(ctx, conversationKey);
  const latestSnapshot = await ctx.refs.conversationLatest.child(conversationKey).get();
  const latestValue = latestSnapshot.exists() ? (latestSnapshot.val() as ConversationLatestRecord) : null;

  if (!messages || messages.length === 0) {
    ctx.stats.skippedNoMessages += 1;
    if (ctx.options.verbose) {
      console.log(`[${conversationKey}] skipped (no messages)`);
    }
    return;
  }

  const participants = extractParticipants(messages, latestValue);
  if (!participants) {
    ctx.stats.skippedParticipants += 1;
    console.warn(`[${conversationKey}] unable to determine participants`);
    return;
  }

  const userConvSnapA = await fetchSnapshot(ctx.refs.userConversations.child(`${participants.aKey}/${conversationKey}`));
  const userConvSnapB = await fetchSnapshot(ctx.refs.userConversations.child(`${participants.bKey}/${conversationKey}`));
  const summarySnapAB = await fetchSnapshot(ctx.refs.conversationSummaries.child(`${participants.aKey}/${participants.bKey}`));
  const summarySnapBA = await fetchSnapshot(ctx.refs.conversationSummaries.child(`${participants.bKey}/${participants.aKey}`));

  const resolution = await determineTenantId(
    ctx,
    conversationKey,
    latestValue,
    participants,
    { a: userConvSnapA, b: userConvSnapB },
    { ab: summarySnapAB, ba: summarySnapBA }
  );

  let tenantId: string | null = null;
  let resolvedVia = '';
  let usedFallback = false;

  if (resolution) {
    tenantId = resolution.tenantId;
    resolvedVia = resolution.source;
    ctx.stats.resolved += 1;
  } else if (ctx.options.fallbackTenantId) {
    tenantId = ctx.options.fallbackTenantId.trim();
    resolvedVia = 'fallback';
    usedFallback = true;
    ctx.stats.fallbackApplied += 1;
  } else {
    ctx.stats.unresolved += 1;
    console.warn(`[${conversationKey}] unresolved tenant`);
    return;
  }

  await applyTenantUpdates(
    ctx,
    conversationKey,
    tenantId,
    messages,
    latestSnapshot.exists() ? latestSnapshot : null,
    { a: userConvSnapA, b: userConvSnapB },
    { ab: summarySnapAB, ba: summarySnapBA }
  );

  if (ctx.options.verbose) {
    const fallbackSuffix = usedFallback ? ' (fallback)' : '';
    console.log(
      `[${conversationKey}] tenant=${tenantId} via ${resolvedVia}${fallbackSuffix}`
    );
  }
}

async function ensureTenantOnSnapshot(
  ctx: Context,
  snapshot: database.DataSnapshot | null,
  tenantId: string,
  counters: () => void,
  description: string
): Promise<void> {
  if (!snapshot) {
    return;
  }
  const value = snapshot.val() as { tenantId?: string | null } | null;
  if (value?.tenantId) {
    if (value.tenantId !== tenantId) {
      ctx.stats.conflicts += 1;
      console.warn(`[${description}] existing tenant mismatch (${value.tenantId} vs ${tenantId})`);
    }
    return;
  }
  counters();
  if (ctx.options.dryRun) {
    console.log(`[dry-run] set ${description} tenantId -> ${tenantId}`);
    return;
  }
  await snapshot.ref.child('tenantId').set(tenantId);
}

async function applyTenantUpdates(
  ctx: Context,
  conversationKey: string,
  tenantId: string,
  messages: database.DataSnapshot[],
  latestSnapshot: database.DataSnapshot | null,
  userConv: { a: database.DataSnapshot | null; b: database.DataSnapshot | null },
  summaries: { ab: database.DataSnapshot | null; ba: database.DataSnapshot | null }
): Promise<void> {
  if (latestSnapshot) {
    await ensureTenantOnSnapshot(
      ctx,
      latestSnapshot,
      tenantId,
      () => {
        ctx.stats.conversationLatestUpdated += 1;
      },
      `conversationLatest/${conversationKey}`
    );
  }

  await ensureTenantOnSnapshot(
    ctx,
    userConv.a,
    tenantId,
    () => {
      ctx.stats.userConversationsUpdated += 1;
    },
    `userConversations/*/${conversationKey}`
  );

  await ensureTenantOnSnapshot(
    ctx,
    userConv.b,
    tenantId,
    () => {
      ctx.stats.userConversationsUpdated += 1;
    },
    `userConversations/*/${conversationKey}`
  );

  await ensureTenantOnSnapshot(
    ctx,
    summaries.ab,
    tenantId,
    () => {
      ctx.stats.conversationSummariesUpdated += 1;
    },
    'conversationSummaries'
  );

  await ensureTenantOnSnapshot(
    ctx,
    summaries.ba,
    tenantId,
    () => {
      ctx.stats.conversationSummariesUpdated += 1;
    },
    'conversationSummaries'
  );

  for (const messageSnapshot of messages) {
    const messageId = messageSnapshot.key;
    if (!messageId) {
      continue;
    }
    const messageValue = messageSnapshot.val() as { tenantId?: string | null } | null;
    if (messageValue?.tenantId) {
      if (messageValue.tenantId !== tenantId) {
        ctx.stats.conflicts += 1;
        console.warn(`[conversationMessages/${conversationKey}/${messageId}] tenant mismatch (${messageValue.tenantId} vs ${tenantId})`);
      }
    } else {
      ctx.stats.messagesUpdated += 1;
      if (ctx.options.dryRun) {
        console.log(`[dry-run] set conversationMessages/${conversationKey}/${messageId} tenantId -> ${tenantId}`);
      } else {
        await messageSnapshot.ref.child('tenantId').set(tenantId);
      }
    }

    const indexRef = ctx.refs.messageIndex.child(messageId).child('tenantId');
    const indexSnapshot = await indexRef.get();
    if (indexSnapshot.exists()) {
      const existing = indexSnapshot.val();
      if (existing && existing !== tenantId) {
        ctx.stats.conflicts += 1;
        console.warn(`[messageIndex/${messageId}] tenant mismatch (${existing} vs ${tenantId})`);
      }
    } else {
      ctx.stats.messageIndexUpdated += 1;
      if (ctx.options.dryRun) {
        console.log(`[dry-run] set messageIndex/${messageId} tenantId -> ${tenantId}`);
      } else {
        await indexRef.set(tenantId);
      }
    }
  }
}

async function processAllConversations(ctx: Context): Promise<void> {
  if (ctx.options.conversation) {
    await backfillConversation(ctx, ctx.options.conversation);
    return;
  }

  let lastKey: string | null = ctx.options.resumeKey ?? null;
  const batchSize = Math.max(1, ctx.options.batchSize);
  const ref = ctx.refs.conversationLatest;

  while (true) {
    let query = ref.orderByKey().limitToFirst(batchSize);
    if (lastKey) {
      const queryAny = query as unknown as { startAfter?: (value: string) => typeof query; startAt: (value: string) => typeof query };
      if (typeof queryAny.startAfter === 'function') {
        query = queryAny.startAfter(lastKey);
      } else {
        query = queryAny.startAt(lastKey);
      }
    }
    const snapshot = await query.get();
    if (!snapshot.exists()) {
      break;
    }

    const keys: string[] = [];
    snapshot.forEach((child) => {
      if (child.key) {
        if (lastKey && child.key === lastKey) {
          return false;
        }
        keys.push(child.key);
        lastKey = child.key;
      }
      return false;
    });

    if (keys.length === 0) {
      break;
    }

    for (const key of keys) {
      if (ctx.options.limit && ctx.stats.conversationsVisited >= ctx.options.limit) {
        return;
      }
      await backfillConversation(ctx, key);
    }

    if (keys.length < batchSize) {
      break;
    }
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  initFirebase();
  const firestore = getFirestore();
  const db = getDatabase();

  console.log('[backfill] loading tenant memberships...');
  const memberships = await loadMembershipIndex(firestore);
  console.log(`[backfill] cached ${memberships.size} membership rows`);

  const ctx: Context = {
    options,
    stats: buildStats(),
    memberships,
    firestore,
    db,
    refs: {
      conversationLatest: db.ref('conversationLatest'),
      conversationMessages: db.ref('conversationMessages'),
      conversationSummaries: db.ref('conversationSummaries'),
      userConversations: db.ref('userConversations'),
      messageIndex: db.ref('messageIndex'),
    },
  };

  await processAllConversations(ctx);

  console.log('[backfill] complete');
  console.table(ctx.stats);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('[backfill] failed', error);
    process.exit(1);
  });
