const logger = {
  debug: (...args) => console.log('[firestore-int]', ...args),
  info: (...args) => console.log('[firestore-int]', ...args),
  warn: (...args) => console.warn('[firestore-int]', ...args),
  error: (...args) => console.error('[firestore-int]', ...args),
};
/*
 Integration test against Firestore emulator.
 This script expects the emulator to be running and FIRESTORE_EMULATOR_HOST set in env.
 It will:
 - initialize firebase-admin with emulator settings
 - write test reminders (mixed statuses)
 - call a lightweight query using the same logic as getPaginatedReminderHistory
 - validate that server-side status filtering + pagination returns expected results
 - clean up created docs

 Usage:
 FIRESTORE_EMULATOR_HOST=localhost:8080 node scripts/runFirestoreIntegration.js
*/

const path = require('path');
const tsNode = require('ts-node');

tsNode.register({
  transpileOnly: true,
  project: path.join(process.cwd(), 'backend-runtime', 'tsconfig.json'),
});

const { initializeApp, getApps, deleteApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getDatabase } = require('firebase-admin/database');
const {
  getConversationKey,
  watchConversationRealtime,
} = require('../backend-runtime/src/chatRealtime');

function ensureAdminApp() {
  if (getApps().length > 0) {
    return;
  }

  initializeApp({
    projectId: 'demo-project',
    databaseURL: 'https://demo-project-default-rtdb.firebaseio.com',
  });
}

async function waitForCondition(predicate, label, timeoutMs = 7000, intervalMs = 30) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      if (predicate()) {
        return;
      }
    } catch {
      // Ignore transient predicate errors and keep polling.
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out waiting for condition: ${label}`);
}

async function runReminderPaginationIntegration(db) {
  logger.debug('Running Firestore reminder pagination integration test...');

  const reminderCol = db.collection('reminderHistory');
  const created = [];

  try {
    // Create 7 test reminders, statuses: success, failed, pending, success, failed, success, pending
    const statuses = ['success', 'failed', 'pending', 'success', 'failed', 'success', 'pending'];
    for (let i = 0; i < statuses.length; i++) {
      const doc = await reminderCol.add({
        userId: 'test-user',
        studentId: `stu-${i % 2}`,
        studentName: `Student ${i}`,
        parentName: `Parent ${i}`,
        parentContact: `99999${i}`,
        reminderType: i % 2 === 0 ? 'sms' : 'email',
        status: statuses[i],
        message: `Test message ${i}`,
        amount: 100 * i,
        dueDate: new Date().toISOString(),
        feeCategories: ['tuition'],
        settings: { useCustomMessage: false, useCustomNotes: false, language: 'english', teacherName: 'Tester' },
        senderName: 'Tester',
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
      created.push(doc.id);
    }

    const pageSize = 2;
    const q = reminderCol
      .where('userId', '==', 'test-user')
      .where('status', '==', 'success')
      .orderBy('createdAt', 'desc')
      .limit(pageSize + 1);
    const snapshot = await q.get();
    const docs = snapshot.docs;

    const hasMore = docs.length > pageSize;
    const docsToProcess = hasMore ? docs.slice(0, pageSize) : docs;
    const results = docsToProcess.map((d) => ({ id: d.id, ...d.data() }));

    if (results.length !== 2) throw new Error('Expected 2 results for first page');
    if (!hasMore) throw new Error('Expected hasMore=true for first page');

    const lastDoc = docsToProcess[docsToProcess.length - 1];
    const q2 = reminderCol
      .where('userId', '==', 'test-user')
      .where('status', '==', 'success')
      .orderBy('createdAt', 'desc')
      .startAfter(lastDoc)
      .limit(pageSize + 1);
    const snapshot2 = await q2.get();
    const docs2 = snapshot2.docs;
    const hasMore2 = docs2.length > pageSize;
    const docsToProcess2 = hasMore2 ? docs2.slice(0, pageSize) : docs2;
    const results2 = docsToProcess2.map((d) => ({ id: d.id, ...d.data() }));

    // There are 3 success statuses in the sample (indexes 5,3,0).
    if (results2.length !== 1) throw new Error('Expected 1 result for second page');
    if (hasMore2) throw new Error('Expected hasMore2=false for second page');

    logger.debug('Integration test - reminder pagination OK');
  } finally {
    for (const id of created) {
      try {
        await reminderCol.doc(id).delete();
      } catch (error) {
        logger.warn('Reminder cleanup failed for doc', id, error);
      }
    }
  }
}

async function runRealtimeWatcherOrderingIntegration() {
  logger.debug('Running realtime watcher ordering integration test...');

  const tenantId = `it-tenant-${Date.now()}`;
  const senderEmail = 'teacher.integration@example.com';
  const recipientEmail = 'parent.integration@example.com';
  const conversationKey = getConversationKey(senderEmail, recipientEmail);
  if (!conversationKey) {
    throw new Error('Failed to resolve integration conversation key');
  }

  const database = getDatabase();
  const conversationRef = database
    .ref('tenantChat')
    .child(tenantId)
    .child('conversationMessages')
    .child(conversationKey);

  const events = [];
  const now = Date.now();
  const isoAt = (offsetMs) => new Date(now + offsetMs).toISOString();

  await conversationRef.remove();

  const stopWatching = await watchConversationRealtime(tenantId, conversationKey, {
    onMessage: (payload) => {
      events.push({ kind: 'message', id: payload.id });
    },
    onStatus: (payload) => {
      events.push({
        kind: 'status',
        id: payload.id,
        delivered: payload.delivered === true,
        read: payload.read === true,
      });
    },
    onMessageUpdate: (payload) => {
      events.push({
        kind: 'update',
        id: payload.id,
        deleted: payload.deleted === true,
      });
    },
    onMessageDelete: (payload) => {
      events.push({ kind: 'delete', id: payload.id });
    },
  });

  try {
    const messageOneRef = conversationRef.child('msg-order-1');
    const messageTwoRef = conversationRef.child('msg-order-2');

    await messageOneRef.set({
      sender: senderEmail,
      recipientId: recipientEmail,
      text: 'hello one',
      timestamp: isoAt(0),
      delivered: false,
      read: false,
    });

    await messageOneRef.update({
      delivered: true,
      deliveredAt: isoAt(1000),
    });

    await messageOneRef.update({
      text: 'edited one',
      editedAt: isoAt(2000),
    });

    await messageTwoRef.set({
      sender: senderEmail,
      recipientId: recipientEmail,
      text: 'hello two',
      timestamp: isoAt(3000),
      delivered: false,
      read: false,
    });

    await messageTwoRef.update({
      read: true,
      readAt: isoAt(4000),
    });

    await messageOneRef.update({
      deleted: true,
      deletedAt: isoAt(5000),
      deletedBy: senderEmail,
    });

    await waitForCondition(
      () => {
        const hasMessageOne = events.some((event) => event.kind === 'message' && event.id === 'msg-order-1');
        const hasMessageTwo = events.some((event) => event.kind === 'message' && event.id === 'msg-order-2');
        const hasStatusOne = events.some((event) => event.kind === 'status' && event.id === 'msg-order-1');
        const hasStatusTwo = events.some((event) => event.kind === 'status' && event.id === 'msg-order-2');
        const hasUpdateOneContent = events.some(
          (event) => event.kind === 'update' && event.id === 'msg-order-1' && event.deleted !== true
        );
        const hasUpdateOneDeleted = events.some(
          (event) => event.kind === 'update' && event.id === 'msg-order-1' && event.deleted === true
        );
        const hasDeleteOne = events.some((event) => event.kind === 'delete' && event.id === 'msg-order-1');

        return (
          hasMessageOne &&
          hasMessageTwo &&
          hasStatusOne &&
          hasStatusTwo &&
          hasUpdateOneContent &&
          hasUpdateOneDeleted &&
          hasDeleteOne
        );
      },
      'realtime watcher mixed burst events'
    );

    const findEventIndex = (predicate) => events.findIndex(predicate);
    const indexMessageOne = findEventIndex((event) => event.kind === 'message' && event.id === 'msg-order-1');
    const indexStatusOne = findEventIndex((event) => event.kind === 'status' && event.id === 'msg-order-1');
    const indexUpdateOneContent = findEventIndex(
      (event) => event.kind === 'update' && event.id === 'msg-order-1' && event.deleted !== true
    );
    const indexMessageTwo = findEventIndex((event) => event.kind === 'message' && event.id === 'msg-order-2');
    const indexStatusTwo = findEventIndex((event) => event.kind === 'status' && event.id === 'msg-order-2');
    const indexUpdateOneDeleted = findEventIndex(
      (event) => event.kind === 'update' && event.id === 'msg-order-1' && event.deleted === true
    );
    const indexDeleteOne = findEventIndex((event) => event.kind === 'delete' && event.id === 'msg-order-1');

    if (!(indexMessageOne < indexStatusOne && indexStatusOne < indexUpdateOneContent)) {
      throw new Error(`Unexpected ordering for msg-order-1 add/status/update: ${JSON.stringify(events)}`);
    }

    if (!(indexMessageTwo < indexStatusTwo)) {
      throw new Error(`Unexpected ordering for msg-order-2 add/status: ${JSON.stringify(events)}`);
    }

    if (!(indexUpdateOneDeleted < indexDeleteOne)) {
      throw new Error(`Delete callback should follow deleted update event: ${JSON.stringify(events)}`);
    }

    logger.debug('Integration test - realtime watcher ordering OK');
  } finally {
    try {
      stopWatching();
    } catch (error) {
      logger.warn('Failed to stop realtime watcher', error);
    }

    try {
      await conversationRef.remove();
    } catch (error) {
      logger.warn('Realtime conversation cleanup failed', error);
    }
  }
}

async function main() {
  const hasFirestoreEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
  const hasDatabaseEmulator = Boolean(process.env.FIREBASE_DATABASE_EMULATOR_HOST);

  if (!hasFirestoreEmulator && !hasDatabaseEmulator) {
    logger.debug(
      'No emulator host detected (FIRESTORE_EMULATOR_HOST/FIREBASE_DATABASE_EMULATOR_HOST unset). Skipping integration test.'
    );
    return;
  }

  ensureAdminApp();

  const failures = [];

  if (hasFirestoreEmulator) {
    try {
      const db = getFirestore();
      await runReminderPaginationIntegration(db);
    } catch (error) {
      failures.push(error);
      logger.error('Firestore reminder pagination integration failed:', error);
    }
  } else {
    logger.debug('Skipping Firestore integration (FIRESTORE_EMULATOR_HOST not set).');
  }

  if (hasDatabaseEmulator) {
    try {
      await runRealtimeWatcherOrderingIntegration();
    } catch (error) {
      failures.push(error);
      logger.error('Realtime watcher ordering integration failed:', error);
    }
  } else {
    logger.debug('Skipping realtime watcher integration (FIREBASE_DATABASE_EMULATOR_HOST not set).');
  }

  if (failures.length > 0) {
    process.exitCode = 2;
  }

  // Delete the Firebase app to close all open SDK connections and allow the
  // process to exit cleanly. Without this, the Firestore and RTDB connections
  // keep the event loop alive indefinitely.
  const apps = getApps();
  if (apps.length > 0) {
    await deleteApp(apps[0]);
  }

  if (failures.length > 0) {
    throw failures[0];
  }
}

main().catch((error) => {
  logger.error('Integration test failed:', error);
  if (!process.exitCode) {
    process.exitCode = 2;
  }
});
