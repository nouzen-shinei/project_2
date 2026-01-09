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

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    logger.debug('Firestore emulator not detected (FIRESTORE_EMULATOR_HOST not set). Skipping integration test.');
    return;
  }

  initializeApp({ projectId: 'demo-project' });
  const db = getFirestore();

  const reminderCol = db.collection('reminderHistory');
  const created = [];

  try {
    // Create 7 test reminders, statuses: success, failed, pending, success, failed, success, pending
    const statuses = ['success','failed','pending','success','failed','success','pending'];
    for (let i=0;i<statuses.length;i++){
      const doc = await reminderCol.add({
        userId: 'test-user',
        studentId: `stu-${i%2}`,
        studentName: `Student ${i}`,
        parentName: `Parent ${i}`,
        parentContact: `99999${i}`,
        reminderType: i%2===0? 'sms' : 'email',
        status: statuses[i],
        message: `Test message ${i}`,
        amount: 100*i,
        dueDate: new Date().toISOString(),
        feeCategories: ['tuition'],
        settings: { useCustomMessage: false, useCustomNotes: false, language: 'english', teacherName: 'Tester' },
        senderName: 'Tester',
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now()
      });
      created.push(doc.id);
    }

    // Query: server-side filter for status='success', pageSize=2
    const pageSize = 2;
    const q = reminderCol.where('userId','==','test-user').where('status','==','success').orderBy('createdAt','desc').limit(pageSize+1);
    const snapshot = await q.get();
    const docs = snapshot.docs;
    logger.debug('Integration test - total docs fetched (including extra):', docs.length);

    const hasMore = docs.length > pageSize;
    const docsToProcess = hasMore ? docs.slice(0,pageSize) : docs;
    const results = docsToProcess.map(d => ({ id: d.id, ...d.data() }));

    logger.debug('Integration test - results length:', results.length, 'hasMore:', hasMore);

    if (results.length !== 2) throw new Error('Expected 2 results for first page');
    if (!hasMore) throw new Error('Expected hasMore=true for first page');

    logger.debug('Integration test - first page OK');

    // Fetch next page
    const lastDoc = docsToProcess[docsToProcess.length-1];
    const q2 = reminderCol.where('userId','==','test-user').where('status','==','success').orderBy('createdAt','desc').startAfter(lastDoc).limit(pageSize+1);
    const snapshot2 = await q2.get();
    const docs2 = snapshot2.docs;
    const hasMore2 = docs2.length > pageSize;
    const docsToProcess2 = hasMore2 ? docs2.slice(0,pageSize) : docs2;
    const results2 = docsToProcess2.map(d => ({ id: d.id, ...d.data() }));

    logger.debug('Integration test - second page results length:', results2.length, 'hasMore2:', hasMore2);

    // There are 3 success statuses in the sample (indexes 5,3,0) -> total 3. So after pageSize=2, second page should have 1 and hasMore2=false
    if (results2.length !== 1) throw new Error('Expected 1 result for second page');
    if (hasMore2) throw new Error('Expected hasMore2=false for second page');

    logger.debug('Integration test - second page OK');

    logger.debug('Integration test passed');
  } catch (err) {
    logger.error('Integration test failed:', err);
    process.exitCode = 2;
  } finally {
    // cleanup
    try{
      for(const id of created){
        await reminderCol.doc(id).delete();
      }
    }catch(e){
      logger.warn('Cleanup failed', e);
    }
  }
}

main();
