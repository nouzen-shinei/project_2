const admin = require('firebase-admin');

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: 'tution-app-6c0c3',
});

const db = admin.firestore();

(async () => {
  const tenantId = process.argv[2] || 'CGnHGq43PFF8WD2DJekx';
  const monthsSnap = await db.collection('tenantUsage').doc(tenantId).collection('months').get();
  const patched = [];

  for (const monthDoc of monthsSnap.docs) {
    const alertsSnap = await monthDoc.ref.collection('alerts').get();
    for (const alertDoc of alertsSnap.docs) {
      const data = alertDoc.data() || {};
      const notifications = data.notifications || {};
      const email = notifications.email || null;
      if (!email || email.disabled !== true) continue;

      const attempted = Number(email.attempted || 0);
      const sent = Number(email.sent || 0);
      if (attempted > 0 || sent > 0) {
        await alertDoc.ref.update({
          'notifications.email.disabled': admin.firestore.FieldValue.delete(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        patched.push({ month: monthDoc.id, alertId: alertDoc.id, attempted, sent });
      }
    }
  }

  console.log(JSON.stringify({ tenantId, patchedCount: patched.length, patched }, null, 2));
  await admin.app().delete();
})().catch(async (error) => {
  console.error(error);
  try {
    await admin.app().delete();
  } catch {}
  process.exit(1);
});
