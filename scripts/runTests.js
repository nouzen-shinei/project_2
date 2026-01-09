const path = require('path');
const tsNode = require('ts-node');

tsNode.register({
  transpileOnly: true,
  project: path.join(__dirname, '..', 'tsconfig.json'),
});

const assert = require('assert');
const { logger } = require('../lib/logger');
const { getChatPaginationProfile } = require('../lib/chatPaginationConfig');
const {
  partitionMessagesByLimit,
  rangesOverlap,
  clampRange,
  deriveRangeFromMessages,
} = require('../lib/chatHistoryPolicy');
const {
  resolveNotificationChannelId,
  ANDROID_CHANNEL_IDS,
} = require('../backend-runtime/src/lib/notificationChannels');
const { resolveChatUploadFolder } = require('../lib/chatUploadUtils');
const {
  PLAN_LIMITS,
  getPlanLimits,
  getUsageStatus,
  getUsagePercentage,
} = require('../backend-runtime/src/lib/planLimits');

logger.debug('Running unit tests (basic runner)');

function processDocsForPagination(docs, pageSize) {
  const hasMore = docs.length > pageSize;
  const docsToProcess = hasMore ? docs.slice(0, pageSize) : docs;
  const reminders = [];
  let newLastDocument = null;

  docsToProcess.forEach((doc) => {
    const data = doc.data();
    reminders.push({ id: doc.id, ...data });
    newLastDocument = doc;
  });

  return { reminders, lastDocument: newLastDocument, hasMore };
}

// Test 1
(function testHasMore() {
  const docs = [];
  for (let i = 0; i < 6; i++) {
    docs.push({ id: `doc-${i}`, data: () => ({ studentName: `Student ${i}`, status: i % 2 === 0 ? 'success' : 'failed' }) });
  }
  const result = processDocsForPagination(docs, 5);
  assert.strictEqual(result.hasMore, true, 'Expected hasMore true for docs > pageSize');
  assert.strictEqual(result.reminders.length, 5, 'Expected 5 reminders');
  assert.strictEqual(result.lastDocument.id, 'doc-4', 'Expected lastDocument to be doc-4');
  logger.debug('✓ testHasMore passed');
})();

// Test 2
(function testNoMore() {
  const docs = [];
  for (let i = 0; i < 3; i++) {
    docs.push({ id: `doc-${i}`, data: () => ({ studentName: `Student ${i}`, status: 'pending' }) });
  }
  const result = processDocsForPagination(docs, 5);
  assert.strictEqual(result.hasMore, false, 'Expected hasMore false for docs <= pageSize');
  assert.strictEqual(result.reminders.length, 3, 'Expected 3 reminders');
  assert.strictEqual(result.lastDocument.id, 'doc-2', 'Expected lastDocument to be doc-2');
  logger.debug('✓ testNoMore passed');
})();

function withEnv(overrides, callback) {
  const backup = {};
  Object.keys(overrides).forEach((key) => {
    backup[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
  try {
    callback();
  } finally {
    Object.keys(overrides).forEach((key) => {
      if (backup[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = backup[key];
      }
    });
  }
}

(function testNativePaginationOverrides() {
  withEnv(
    {
      EXPO_PUBLIC_CHAT_PAGE_SIZE_NATIVE: '18',
      EXPO_PUBLIC_CHAT_BOOTSTRAP_PAGES_NATIVE: '3',
      EXPO_PUBLIC_CHAT_CACHE_LIMIT_NATIVE: '600',
      EXPO_PUBLIC_CHAT_PREFETCH_THRESHOLD_NATIVE: '5',
    },
    () => {
      const profile = getChatPaginationProfile('native');
      assert.strictEqual(profile.pageSize, 18, 'Native page size override failed');
      assert.strictEqual(profile.bootstrapPages, 3, 'Native bootstrap pages override failed');
      assert.strictEqual(profile.bootstrapWindowSize, 54, 'Native bootstrap window mismatch');
      assert.strictEqual(profile.cacheLimit, 600, 'Native cache limit override failed');
      assert.strictEqual(profile.prefetchThreshold, 5, 'Native prefetch threshold override failed');
      logger.debug('✓ testNativePaginationOverrides passed');
    }
  );
})();

(function testWebPaginationSharedFallback() {
  withEnv(
    {
      EXPO_PUBLIC_CHAT_PAGE_SIZE: '40',
      EXPO_PUBLIC_CHAT_BOOTSTRAP_PAGES: '1',
      EXPO_PUBLIC_CHAT_CACHE_LIMIT: '200',
      EXPO_PUBLIC_CHAT_PREFETCH_THRESHOLD: '2',
      EXPO_PUBLIC_CHAT_PAGE_SIZE_WEB: undefined,
      EXPO_PUBLIC_CHAT_BOOTSTRAP_PAGES_WEB: undefined,
      EXPO_PUBLIC_CHAT_CACHE_LIMIT_WEB: undefined,
      EXPO_PUBLIC_CHAT_PREFETCH_THRESHOLD_WEB: undefined,
    },
    () => {
      const profile = getChatPaginationProfile('web');
      assert.strictEqual(profile.pageSize, 40, 'Web shared fallback page size failed');
      assert.strictEqual(profile.bootstrapPages, 1, 'Web shared fallback bootstrap pages failed');
      assert.strictEqual(profile.cacheLimit, 200, 'Web shared fallback cache limit failed');
      assert.strictEqual(profile.prefetchThreshold, 2, 'Web shared fallback prefetch threshold failed');
      logger.debug('✓ testWebPaginationSharedFallback passed');
    }
  );
})();

(function testPaginationDefaults() {
  const profile = getChatPaginationProfile('native');
  assert(profile.pageSize > 0 && profile.bootstrapPages > 0, 'Defaults should be positive');
  assert.strictEqual(profile.bootstrapWindowSize, profile.pageSize * profile.bootstrapPages, 'Bootstrap window mismatch');
  assert(profile.cacheLimit >= profile.bootstrapWindowSize, 'Cache limit should cover bootstrap window');
  logger.debug('✓ testPaginationDefaults passed');
})();

(function testPartitionMessagesByLimit() {
  const sample = Array.from({ length: 6 }, (_, idx) => ({
    timestamp: new Date(2025, 0, idx + 1).toISOString(),
    id: idx,
  }));
  const { retained, spilled } = partitionMessagesByLimit(sample, 4);
  assert.strictEqual(retained.length, 4, 'Partition should retain the latest N messages');
  assert.strictEqual(spilled.length, 2, 'Partition should spill the oldest remainder');
  assert.strictEqual(retained[0].id, 2, 'Retained window should start at id=2');
  assert.strictEqual(spilled[0].id, 0, 'Spilled window should include oldest message');
  logger.debug('✓ testPartitionMessagesByLimit passed');
})();

(function testRangeOverlapHelpers() {
  const primary = { startTimestamp: '2025-01-01T00:00:00Z', endTimestamp: '2025-01-02T00:00:00Z' };
  const touching = { startTimestamp: '2025-01-02T00:00:00Z', endTimestamp: '2025-01-03T00:00:00Z' };
  const distant = { startTimestamp: '2025-02-01T00:00:00Z', endTimestamp: '2025-02-02T00:00:00Z' };
  assert(rangesOverlap(primary, touching), 'Ranges that touch at endpoints should be considered overlapping');
  assert(!rangesOverlap(primary, distant), 'Distinct ranges should not overlap');
  const reversed = clampRange({ startTimestamp: primary.endTimestamp, endTimestamp: primary.startTimestamp });
  assert.strictEqual(reversed?.startTimestamp, primary.startTimestamp, 'Clamp should normalize out-of-order ranges');
  logger.debug('✓ testRangeOverlapHelpers passed');
})();

(function testDeriveRangeFromMessages() {
  const payload = [
    { timestamp: '2025-03-03T10:00:00Z' },
    { timestamp: '2025-03-01T08:00:00Z' },
    { timestamp: '2025-03-05T12:30:00Z' },
  ];
  const range = deriveRangeFromMessages(payload);
  assert(range, 'Range should be derived from timestamped messages');
  assert.strictEqual(range?.startTimestamp, '2025-03-01T08:00:00Z', 'Derived range should pick oldest timestamp as start');
  assert.strictEqual(range?.endTimestamp, '2025-03-05T12:30:00Z', 'Derived range should pick newest timestamp as end');
  logger.debug('✓ testDeriveRangeFromMessages passed');
})();

(function testNotificationChannelResolverMappings() {
  const scenarios = [
    { input: { type: 'chat_message' }, expected: ANDROID_CHANNEL_IDS.CHAT, label: 'chat messages' },
    { input: { type: 'daily_quote' }, expected: ANDROID_CHANNEL_IDS.DAILY_QUOTES, label: 'daily quotes' },
    { input: { type: 'fee_overdue_alert' }, expected: ANDROID_CHANNEL_IDS.IMPORTANT, label: 'important alerts' },
    { input: { type: 'notice_created' }, expected: ANDROID_CHANNEL_IDS.NOTICES, label: 'notice board updates' },
    { input: { type: 'system_update' }, expected: ANDROID_CHANNEL_IDS.MISC, label: 'misc notifications' },
    { input: { type: 'birthday_greeting' }, expected: ANDROID_CHANNEL_IDS.MISC, label: 'birthday greetings' },
    { input: { type: 'unknown_type' }, expected: ANDROID_CHANNEL_IDS.GENERAL, label: 'fallback notifications' },
    { input: { priority: 'HIGH' }, expected: ANDROID_CHANNEL_IDS.IMPORTANT, label: 'priority override' },
  ];

  scenarios.forEach(({ input, expected, label }) => {
    const resolved = resolveNotificationChannelId(input);
    assert.strictEqual(
      resolved,
      expected,
      `Expected ${label} to route to channel ${expected}, received ${resolved}`
    );
  });

  logger.debug('✓ testNotificationChannelResolverMappings passed');
})();

(function testChatUploadFolderResolution() {
  const dual = resolveChatUploadFolder({
    senderEmail: 'Alice.Teacher@example.com',
    recipientEmail: 'parent.ONE@school.edu',
  });
  assert.strictEqual(
    dual,
    'alice_teacher_example_com__parent_one_school_edu',
    'Expected folder to contain both participants as sanitized keys'
  );

  const single = resolveChatUploadFolder({ senderEmail: 'solo.user@demo.org' });
  assert.strictEqual(single, 'solo_user_demo_org', 'Single participant should fall back to their sanitized key');

  const fallback = resolveChatUploadFolder({});
  assert.strictEqual(fallback, 'unassigned', 'Missing participants should fall back to unassigned folder');

  logger.debug('✓ testChatUploadFolderResolution passed');
})();

(function testPlanLimitsHelpers() {
  const free = getPlanLimits('free');
  assert.strictEqual(free.staffSeats, 3, 'Free plan seats mismatch');
  const fallback = getPlanLimits('unknown');
  assert.strictEqual(fallback.id, 'free', 'Unknown plan should fall back to free');

  assert.strictEqual(getUsageStatus(40, 100), 'ok', 'Usage under 80% should be ok');
  assert.strictEqual(getUsageStatus(85, 100), 'warning', 'Usage >=80% should warn');
  assert.strictEqual(getUsageStatus(101, 100), 'critical', 'Usage >=100% should be critical');

  const percent = getUsagePercentage(42, 75);
  assert(percent > 55 && percent < 57, 'Percentage should be ~56%');

  logger.debug('✓ testPlanLimitsHelpers passed');
})();

logger.debug('All basic tests passed');

// If emulator is available, run integration test
if (process.env.FIRESTORE_EMULATOR_HOST) {
  logger.debug('Detected Firestore emulator environment; running integration test...');
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, ['scripts/runFirestoreIntegration.js'], { stdio: 'inherit' });
  child.on('close', (code) => {
    if (code !== 0) {
      logger.error('Integration test failed with code', code);
      process.exit(code);
    } else {
      logger.debug('Integration test completed successfully');
    }
  });
}
