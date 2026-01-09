import assert from 'assert';
import { beforeEach, describe, it } from 'node:test';
import {
  buildTeamMembershipCopy,
  sendTeamMembershipChangeNotification,
  sendTenantJoinRequestNotification,
  sendTenantJoinRequestOutcomeNotification,
  __setTeamMembershipNotifierTestOverrides,
  __resetTeamMembershipNotifierTestState,
} from '../dist/teamMembershipNotifier.js';

process.env.TEST_MODE = '1';

function createFirestoreStub({ adminEmails, devicesByEmail, tenantsById = {}, tenantMembershipsByTenant = {}, counters }) {
  return {
    collection(name) {
      if (name === 'authorizedEmails') {
        return {
          where(field, op, value) {
            assert.equal(field, 'role');
            assert.equal(op, '==');
            assert.equal(value, 'admin');
            return {
              async get() {
                counters.adminQueries += 1;
                return {
                  docs: adminEmails.map((email) => ({
                    get(key) {
                      if (key === 'email') return email;
                      if (key === 'role') return 'admin';
                      return undefined;
                    },
                  })),
                };
              },
            };
          },
        };
      }

      if (name === 'user_devices') {
        return {
          doc(email) {
            const normalized = email.toLowerCase();
            return {
              collection(subName) {
                assert.equal(subName, 'devices');
                return {
                  select() {
                    return {
                      async get() {
                        const previous = counters.deviceQueries.get(normalized) ?? 0;
                        counters.deviceQueries.set(normalized, previous + 1);
                        const deviceRecords = devicesByEmail[normalized] ?? [];
                        return {
                          docs: deviceRecords.map((device, idx) => ({
                            ref: {
                              path: `user_devices/${normalized}/devices/${device.deviceId ?? `device-${idx}`}`,
                            },
                            data() {
                              return { ...device };
                            },
                          })),
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }

      if (name === 'tenants') {
        return {
          doc(id) {
            return {
              async get() {
                counters.tenantQueries = (counters.tenantQueries ?? 0) + 1;
                const data = tenantsById[id];
                return {
                  exists: Boolean(data),
                  data() {
                    return data ? { ...data } : undefined;
                  },
                };
              },
            };
          },
        };
      }

      if (name === 'tenantMemberships') {
        return {
          where(field, op, value) {
            assert.equal(field, 'tenantId');
            assert.equal(op, '==');
            const tenantId = value;
            return {
              where(field2, op2, value2) {
                assert.equal(field2, 'status');
                assert.equal(op2, '==');
                const status = value2;
                const buildResponse = (roleFilter) => ({
                  async get() {
                    counters.tenantMembershipQueries = (counters.tenantMembershipQueries ?? 0) + 1;
                    const records = (tenantMembershipsByTenant[tenantId] ?? []).filter((record) => {
                      if (record.status !== status) {
                        return false;
                      }
                      if (!roleFilter) {
                        return true;
                      }
                      const normalizedRole = typeof record.role === 'string' ? record.role : '';
                      return roleFilter.has(normalizedRole);
                    });
                    return {
                      docs: records.map((record) => ({
                        data() {
                          return { ...record };
                        },
                        get(key) {
                          return record?.[key];
                        },
                      })),
                    };
                  },
                });

                return {
                  where(field3, op3, value3) {
                    assert.equal(field3, 'role');
                    assert.equal(op3, 'in');
                    const roles = Array.isArray(value3) ? value3 : [];
                    return buildResponse(new Set(roles));
                  },
                  ...buildResponse(),
                };
              },
            };
          },
        };
      }

      throw new Error(`Unknown collection: ${name}`);
    },
  };
}

describe('team membership notifier', () => {
  beforeEach(() => {
    __resetTeamMembershipNotifierTestState();
    __setTeamMembershipNotifierTestOverrides({});
  });

  it('builds descriptive copy for each action type', () => {
    const added = buildTeamMembershipCopy({
      action: 'added',
      targetEmail: 'new.admin@example.com',
      targetRole: 'admin',
      metadata: { displayName: 'Alex Admin', actorName: 'Owner Name' },
      actorEmail: 'owner@example.com',
    });
    assert.equal(added.title, 'New admin added');
    assert.match(added.body, /Alex Admin/);
    assert.match(added.body, /Owner Name/);

    const removed = buildTeamMembershipCopy({
      action: 'removed',
      targetEmail: 'user@example.com',
      metadata: { displayName: 'Casey User' },
    });
    assert.equal(removed.title, 'Member removed');
    assert.match(removed.body, /Casey User/);

    const promoted = buildTeamMembershipCopy({
      action: 'role_changed',
      targetEmail: 'promoted@example.com',
      previousRole: 'user',
      targetRole: 'admin',
      metadata: { displayName: 'Jordan' },
    });
    assert.equal(promoted.title, 'Member promoted to admin');
    assert.match(promoted.body, /Jordan/);

    const demoted = buildTeamMembershipCopy({
      action: 'role_changed',
      targetEmail: 'demoted@example.com',
      previousRole: 'admin',
      targetRole: 'user',
    });
    assert.equal(demoted.title, 'Admin role updated');
  });

  it('sends notifications while respecting caches and preferences', async () => {
    const adminEmails = ['admin1@example.com', 'Admin2@Example.com'];
    const devicesByEmail = {
      'admin1@example.com': [
        {
          deviceId: 'dev-a1',
          expoPushToken: 'ExponentPushToken[A1]',
          notificationsEnabled: true,
          teamNotificationsEnabled: true,
        },
      ],
      'admin2@example.com': [
        {
          deviceId: 'dev-b1',
          expoPushToken: 'ExponentPushToken[A2]',
          notificationsEnabled: true,
          teamNotificationsEnabled: true,
        },
        {
          deviceId: 'dev-b2',
          expoPushToken: 'ExponentPushToken[A2]',
          notificationsEnabled: true,
          teamNotificationsEnabled: false,
        },
        {
          deviceId: 'dev-b3',
          expoPushToken: 'ExponentPushToken[muted]',
          notificationsEnabled: false,
        },
        {
          deviceId: 'dev-b4',
          expoPushToken: 'ExponentPushToken[team-off]',
          notificationsEnabled: true,
          teamNotificationsEnabled: false,
        },
        {
          deviceId: 'dev-b5',
          expoPushToken: 'ExponentPushToken[deleted]',
          notificationsEnabled: true,
          isDeleted: true,
        },
      ],
    };

    const counters = { adminQueries: 0, tenantMembershipQueries: 0, deviceQueries: new Map() };
    const firestoreStub = createFirestoreStub({
      adminEmails,
      devicesByEmail,
      tenantMembershipsByTenant: {
        'legacy-coaching': [
          { email: 'admin1@example.com', role: 'owner', status: 'active' },
          { email: 'Admin2@Example.com', role: 'admin', status: 'active' },
        ],
      },
      counters,
    });
    const sentMessages = [];
    const invalidRecords = [];
    const membershipEmailCalls = [];

    __setTeamMembershipNotifierTestOverrides({
      firestore: firestoreStub,
      sendExpo: async (messages) => {
        sentMessages.push(...messages);
        return {
          sent: messages.length,
          failed: 0,
          invalidTokens: messages.length ? ['ExponentPushToken[A2]'] : [],
        };
      },
      markInvalid: async (records) => {
        invalidRecords.push(...records);
      },
      sendMembershipChangeEmail: async (event, recipients) => {
        membershipEmailCalls.push({ event, recipients });
        return { attempted: recipients.length, sent: recipients.length, failed: 0, skipped: 0 };
      },
    });

    const firstResult = await sendTeamMembershipChangeNotification({
      action: 'added',
      targetEmail: 'newuser@example.com',
      targetRole: 'admin',
      actorEmail: 'admin1@example.com',
      metadata: { displayName: 'New User', initiatedFrom: 'web', actorName: 'Lead Admin' },
    });

    assert.equal(firstResult.ok, true);
    assert.equal(firstResult.sent, 1);
    assert.equal(firstResult.failed, 0);
    assert.equal(firstResult.recipients, 2);
    assert.equal(sentMessages.length, 1);
    const sentTokens = sentMessages.map((msg) => msg.to).sort();
    assert.deepEqual(sentTokens, ['ExponentPushToken[A1]']);
    sentMessages.forEach((msg) => {
      assert.equal(msg.data.type, 'team_membership_change');
      assert.match(msg.body, /Lead Admin/);
    });
    assert.equal(invalidRecords.length, 0);

    // Second call should reuse caches and short-circuit when no recipients remain
    const secondResult = await sendTeamMembershipChangeNotification({
      action: 'removed',
      targetEmail: 'Admin2@example.com',
      targetRole: 'admin',
      actorEmail: 'admin1@example.com',
    });
    assert.equal(secondResult.recipients, 1);
    assert.equal(sentMessages.length, 2);

    assert.equal(counters.tenantMembershipQueries, 1);
    assert.equal(counters.deviceQueries.get('admin2@example.com'), 1);
    assert.equal(counters.deviceQueries.get('admin1@example.com'), 1);
    assert.equal(membershipEmailCalls.length, 0);
  });

  it('sends join request notifications to tenant admins when enabled', async () => {
    const tenantId = 'tenant-123';
    const devicesByEmail = {
      'owner@example.com': [
        {
          deviceId: 'owner-1',
          expoPushToken: 'ExponentPushToken[OWNER]',
          notificationsEnabled: true,
          teamNotificationsEnabled: true,
        },
      ],
    };
    const counters = { adminQueries: 0, deviceQueries: new Map() };
    const firestoreStub = createFirestoreStub({
      adminEmails: [],
      devicesByEmail,
      tenantsById: {
        [tenantId]: {
          name: 'Alpha Academy',
          notificationPreferences: { joinRequestPush: true },
        },
      },
      tenantMembershipsByTenant: {
        [tenantId]: [
          { email: 'owner@example.com', role: 'owner', status: 'active' },
          { email: 'staff@example.com', role: 'staff', status: 'active' },
        ],
      },
      counters,
    });

    const sentMessages = [];

    __setTeamMembershipNotifierTestOverrides({
      firestore: firestoreStub,
      sendExpo: async (messages) => {
        sentMessages.push(...messages);
        return { sent: messages.length, failed: 0, invalidTokens: [] };
      },
      markInvalid: async () => {},
    });

    const result = await sendTenantJoinRequestNotification({
      tenantId,
      tenantName: 'Alpha Academy',
      requestId: 'req-1',
      requesterEmail: 'applicant@example.com',
      requesterName: 'Applicant',
      message: 'Please approve me',
    });

    assert.equal(result.ok, true);
    assert.equal(result.sent, 1);
    assert.equal(result.recipients, 1);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].data.type, 'tenant_join_request');
    assert.equal(sentMessages[0].data.tenantId, tenantId);
    assert.equal(sentMessages[0].data.requesterEmail, 'applicant@example.com');
  });

  it('skips join request notifications when tenant preference disables push', async () => {
    const tenantId = 'tenant-muted';
    const firestoreStub = createFirestoreStub({
      adminEmails: [],
      devicesByEmail: {},
      tenantsById: {
        [tenantId]: {
          name: 'Muted Academy',
          notificationPreferences: { joinRequestPush: false },
        },
      },
      tenantMembershipsByTenant: {
        [tenantId]: [{ email: 'owner@example.com', role: 'owner', status: 'active' }],
      },
      counters: { adminQueries: 0, deviceQueries: new Map() },
    });

    __setTeamMembershipNotifierTestOverrides({ firestore: firestoreStub });

    const result = await sendTenantJoinRequestNotification({
      tenantId,
      requestId: 'req-muted',
      requesterEmail: 'user@example.com',
    });

    assert.equal(result.ok, true);
    assert.equal(result.sent, 0);
    assert.equal(result.recipients, 1);
  });

  it('sends join request emails when email preference is enabled', async () => {
    const tenantId = 'tenant-email-on';
    const emailCalls = [];
    const firestoreStub = createFirestoreStub({
      adminEmails: [],
      devicesByEmail: {},
      tenantsById: {
        [tenantId]: {
          name: 'Signal Academy',
          notificationPreferences: { joinRequestEmail: true, joinRequestPush: false },
        },
      },
      tenantMembershipsByTenant: {
        [tenantId]: [
          { email: 'owner@example.com', role: 'owner', status: 'active' },
          { email: 'admin@example.com', role: 'admin', status: 'active' },
        ],
      },
      counters: { adminQueries: 0, deviceQueries: new Map() },
    });

    __setTeamMembershipNotifierTestOverrides({
      firestore: firestoreStub,
      sendJoinRequestEmail: async (event, recipients) => {
        emailCalls.push({ event, recipients });
        return { attempted: recipients.length, sent: recipients.length, failed: 0, skipped: 0 };
      },
    });

    const result = await sendTenantJoinRequestNotification({
      tenantId,
      requestId: 'req-email',
      requesterEmail: 'candidate@example.com',
      tenantName: 'Signal Academy',
      requesterName: 'Candidate',
      message: 'Please add me',
    });

    assert.equal(result.ok, true);
    assert.equal(result.recipients, 2);
    assert.equal(result.sent, 0);
    assert.equal(emailCalls.length, 1);
    assert.deepEqual(emailCalls[0].recipients.sort(), ['admin@example.com', 'owner@example.com']);
    assert.equal(result.emailSummary?.sent, 2);
  });

  it('skips join request emails when preference is disabled', async () => {
    const tenantId = 'tenant-email-off';
    const emailCalls = [];
    const firestoreStub = createFirestoreStub({
      adminEmails: [],
      devicesByEmail: {},
      tenantsById: {
        [tenantId]: {
          name: 'Mute Academy',
          notificationPreferences: { joinRequestEmail: false, joinRequestPush: false },
        },
      },
      tenantMembershipsByTenant: {
        [tenantId]: [{ email: 'owner@example.com', role: 'owner', status: 'active' }],
      },
      counters: { adminQueries: 0, deviceQueries: new Map() },
    });

    __setTeamMembershipNotifierTestOverrides({
      firestore: firestoreStub,
      sendJoinRequestEmail: async () => {
        emailCalls.push('called');
        return { attempted: 1, sent: 1, failed: 0, skipped: 0 };
      },
    });

    const result = await sendTenantJoinRequestNotification({
      tenantId,
      requestId: 'req-email-off',
      requesterEmail: 'candidate@example.com',
    });

    assert.equal(result.ok, true);
    assert.equal(result.recipients, 1);
    assert.equal(emailCalls.length, 0);
    assert.equal(result.emailSummary, undefined);
  });

  it('notifies requester when join request is approved or rejected', async () => {
    const tenantId = 'tenant-delta';
    const requesterEmail = 'applicant@example.com';
    const devicesByEmail = {
      [requesterEmail]: [
        {
          deviceId: 'req-1',
          expoPushToken: 'ExponentPushToken[REQ]',
          notificationsEnabled: true,
          teamNotificationsEnabled: true,
        },
      ],
    };
    const firestoreStub = createFirestoreStub({
      adminEmails: [],
      devicesByEmail,
      tenantsById: {
        [tenantId]: { name: 'Delta Academy' },
      },
      tenantMembershipsByTenant: {},
      counters: { adminQueries: 0, deviceQueries: new Map() },
    });

    const sentMessages = [];

    __setTeamMembershipNotifierTestOverrides({
      firestore: firestoreStub,
      sendExpo: async (messages) => {
        sentMessages.push(...messages);
        return { sent: messages.length, failed: 0, invalidTokens: [] };
      },
      markInvalid: async () => {},
    });

    const approved = await sendTenantJoinRequestOutcomeNotification({
      tenantId,
      requestId: 'req-42',
      requesterEmail,
      requesterName: 'Casey Applicant',
      outcome: 'approved',
      assignedRole: 'staff',
      reviewerName: 'Lead Admin',
    });

    assert.equal(approved.ok, true);
    assert.equal(approved.sent, 1);
    assert.equal(approved.recipients, 1);
    assert.equal(sentMessages.length, 1);
    assert.equal(sentMessages[0].data.type, 'tenant_join_request_outcome');
    assert.equal(sentMessages[0].data.outcome, 'approved');

    const rejected = await sendTenantJoinRequestOutcomeNotification({
      tenantId,
      requestId: 'req-43',
      requesterEmail,
      outcome: 'rejected',
      reviewerEmail: 'owner@example.com',
    });

    assert.equal(rejected.ok, true);
    assert.equal(rejected.sent, 1);
    assert.equal(sentMessages.length, 2);
    assert.equal(sentMessages[1].data.outcome, 'rejected');
    assert.equal(sentMessages[1].data.reviewerEmail, 'owner@example.com');
  });

  it('skips requester push notifications when join request push is disabled', async () => {
    const tenantId = 'tenant-muted';
    const requesterEmail = 'quiet@example.com';
    const firestoreStub = createFirestoreStub({
      adminEmails: [],
      devicesByEmail: {
        [requesterEmail]: [
          {
            deviceId: 'quiet-1',
            expoPushToken: 'ExponentPushToken[QUIET]',
            notificationsEnabled: true,
            teamNotificationsEnabled: true,
          },
        ],
      },
      tenantsById: {
        [tenantId]: {
          name: 'Muted Academy',
          notificationPreferences: { joinRequestPush: false },
        },
      },
      tenantMembershipsByTenant: {},
      counters: { adminQueries: 0, deviceQueries: new Map() },
    });

    __setTeamMembershipNotifierTestOverrides({
      firestore: firestoreStub,
      sendExpo: async () => {
        assert.fail('push notifications should be disabled by preference');
      },
    });

    const result = await sendTenantJoinRequestOutcomeNotification({
      tenantId,
      requestId: 'req-muted',
      requesterEmail,
      outcome: 'approved',
    });

    assert.equal(result.ok, true);
    assert.equal(result.sent, 0);
    assert.equal(result.recipients, 1);
  });

  it('sends membership change emails when tenant preferences enable them', async () => {
    const tenantId = 'tenant-email';
    const firestoreStub = createFirestoreStub({
      adminEmails: [],
      devicesByEmail: {},
      tenantsById: {
        [tenantId]: {
          name: 'Alpha Academy',
          notificationPreferences: {
            membershipEventsPush: false,
            membershipEventsEmail: true,
          },
        },
      },
      tenantMembershipsByTenant: {
        [tenantId]: [
          { email: 'owner@example.com', role: 'owner', status: 'active' },
          { email: 'admin@example.com', role: 'admin', status: 'active' },
        ],
      },
      counters: { adminQueries: 0, deviceQueries: new Map() },
    });

    const emailCalls = [];

    __setTeamMembershipNotifierTestOverrides({
      firestore: firestoreStub,
      sendExpo: async () => {
        assert.fail('push notifications should be disabled by preference');
      },
      sendMembershipChangeEmail: async (event, recipients) => {
        emailCalls.push({ event, recipients });
        return { attempted: recipients.length, sent: recipients.length, failed: 0, skipped: 0 };
      },
    });

    const result = await sendTeamMembershipChangeNotification({
      tenantId,
      tenantName: 'Alpha Academy',
      action: 'added',
      targetEmail: 'admin@example.com',
      targetRole: 'admin',
      actorEmail: 'owner@example.com',
      metadata: { actorName: 'Lead Admin', displayName: 'Admin Example' },
    });

    assert.equal(result.sent, 0);
    assert.equal(result.failed, 0);
    assert.equal(result.recipients, 1);
    assert.ok(result.emailSummary);
    assert.equal(result.emailSummary.sent, 1);
    assert.equal(emailCalls.length, 1);
    assert.equal(emailCalls[0].recipients.length, 1);
    assert.equal(emailCalls[0].recipients[0], 'owner@example.com');
    assert.equal(emailCalls[0].event.summaryTitle, 'New admin added');
    assert.match(emailCalls[0].event.summaryBody, /Admin Example/);
  });
});
