import { logger } from '@/lib/logger';
/*
 Migration script to backfill `senderName` from `settings.teacherName` for existing reminderHistory and reminderBatches documents.
 This uses the Firebase Admin SDK and requires credentials or emulator.

 Usage (emulator):
 FIRESTORE_EMULATOR_HOST=localhost:8080 node scripts/migrateSenderName.js

 Usage (prod with service account):
 GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json node scripts/migrateSenderName.js
*/

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

async function main() {
  try {
    initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'demo-project' });
    const db = getFirestore();

    // Backfill reminderHistory
    const reminderCol = db.collection('reminderHistory');
    const snapshot = await reminderCol.get();
    logger.debug('Found', snapshot.size, 'reminderHistory docs');
    let updated = 0;
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (!data.senderName && data.settings && data.settings.teacherName) {
        await reminderCol.doc(doc.id).update({ senderName: data.settings.teacherName });
        updated++;
      }
    }
    logger.debug('Updated', updated, 'reminderHistory docs');

    // Backfill reminderBatches
    const batchCol = db.collection('reminderBatches');
    const bSnapshot = await batchCol.get();
    logger.debug('Found', bSnapshot.size, 'reminderBatches docs');
    let bUpdated = 0;
    for (const doc of bSnapshot.docs) {
      const data = doc.data();
      if (!data.senderName && data.settings && data.settings.teacherName) {
        await batchCol.doc(doc.id).update({ senderName: data.settings.teacherName });
        bUpdated++;
      }
    }
    logger.debug('Updated', bUpdated, 'reminderBatches docs');

    logger.debug('Migration complete');
  } catch (err) {
    logger.error('Migration failed', err);
    process.exitCode = 2;
  }
}

main();
