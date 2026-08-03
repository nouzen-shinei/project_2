// Unit tests: services/notificationService survives malformed Firestore chat data.
//
// `ChatMessage.sender`, `FileAttachment.fileType` and `FileAttachment.fileName`
// are all TYPED `string`, but they are read back from Firestore documents — the
// type is a claim about what writers are supposed to store, not a guarantee
// about what a stored document contains. A message written without a sender, or
// an attachment written without a `fileType`, used to throw
// ("Cannot read properties of undefined (reading 'toLowerCase')") inside
// `getFileTypeEmoji` / `extractDisplayName` / `sendSmartChatNotification` and
// take the whole chat notification down with it — the same defect class that was
// closed in `lib/fileUtils.ts` (see __tests__/utils/fileUtilsNullSafety.test.ts).
//
// These tests pin three things:
//   1. no classifier throws for a nullish / non-string fileType or fileName
//   2. the filename-extension fallback still decides in that case (an absent
//      mime type is not the same as "unknown file")
//   3. emoji output for VALID inputs is unchanged — this is null-safety only
// plus the real public notification path completing for a malformed message.

// ---------------------------------------------------------------------------
// Module-level mocks — everything the real notificationService pulls in at
// import time is stubbed so the code under test runs with no native / firebase /
// network dependencies. Mirrors the scaffold in notificationWrapperContract.test.ts.
// ---------------------------------------------------------------------------

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  metric: jest.fn(),
};

jest.mock('../../services/deviceTrackingService', () => ({
  __esModule: true,
  deviceTrackingService: {
    sendNotificationToUser: jest.fn(async () => ({ success: 0, failed: 0, pushAcceptedCount: 0 })),
    getUserDevices: jest.fn(async () => []),
    updateCurrentDeviceChatState: jest.fn(async () => {}),
  },
}));
jest.mock('@/lib/logger', () => ({ __esModule: true, logger: mockLogger }));
jest.mock('@/lib/expoProjectId', () => ({ __esModule: true, resolveExpoProjectId: jest.fn(() => 'project-id') }));
jest.mock('@/lib/notificationChannels', () => ({
  __esModule: true,
  ANDROID_CHANNEL_IDS: {},
  getAndroidChannelDefinition: jest.fn(() => ({})),
  resolveNotificationChannelId: jest.fn(() => 'default'),
}));
jest.mock('react-native', () => ({ __esModule: true, Platform: { OS: 'web' } }));
jest.mock('expo-notifications', () => ({
  __esModule: true,
  setNotificationHandler: jest.fn(),
  addNotificationReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  setNotificationCategoryAsync: jest.fn(async () => {}),
  getPresentedNotificationsAsync: jest.fn(async () => []),
  DEFAULT_ACTION_IDENTIFIER: 'default',
}));
jest.mock('expo-device', () => ({ __esModule: true, isDevice: false }));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) },
}));
jest.mock('../../services/twilioBackendClient', () => ({ __esModule: true, twilioBackendClient: {} }));
jest.mock('../../services/chatReceiptSync', () => ({
  __esModule: true,
  confirmInboundChatDeliveryFromNotificationData: jest.fn(async () => {}),
  flushPendingInboundChatDeliveryReceipts: jest.fn(async () => {}),
}));
jest.mock('../../services/quotesService', () => ({ __esModule: true, quotesService: {} }));
jest.mock('../../types', () => ({ __esModule: true }));
jest.mock('../../services/chatService', () => ({ __esModule: true, chatService: {} }));
jest.mock('../../services/adminNotificationHistoryService', () => ({ __esModule: true, adminNotificationHistoryService: {} }));
jest.mock('expo-router', () => ({ __esModule: true, router: { push: jest.fn(), replace: jest.fn() } }));
jest.mock('../../services/tenantService', () => ({
  __esModule: true,
  tenantService: { getCachedSelectedTenant: jest.fn(async () => 'tenant-x') },
}));
jest.mock('../../services/runtimeEndpoints', () => ({ __esModule: true, runtimeEndpoints: {} }));

import { notificationService } from '../../services/notificationService';

// The classifiers under test are private implementation details of the service;
// reach them directly so a failure points at the classifier, not at whichever
// notification path happened to call it.
const emojiFor = (fileType: unknown, fileName: unknown): string =>
  (notificationService as any).getFileTypeEmoji(fileType, fileName);

const displayNameFor = (email: unknown): string =>
  (notificationService as any).extractDisplayName(email);

// Values a Firestore document can realistically produce for a field the type
// system insists is a `string`.
const MALFORMED_VALUES: unknown[] = [undefined, null, 42, {}, []];

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getFileTypeEmoji tolerates malformed attachment metadata', () => {
  it('does not throw for a nullish or non-string fileType', () => {
    for (const fileType of MALFORMED_VALUES) {
      expect(typeof emojiFor(fileType, 'report.pdf')).toBe('string');
      expect(emojiFor(fileType, 'report.pdf').length).toBeGreaterThan(0);
    }
  });

  it('does not throw for a nullish or non-string fileName', () => {
    for (const fileName of MALFORMED_VALUES) {
      expect(typeof emojiFor('video/mp4', fileName)).toBe('string');
      expect(emojiFor('video/mp4', fileName).length).toBeGreaterThan(0);
    }
  });

  it('does not throw when BOTH fileType and fileName are malformed', () => {
    for (const value of MALFORMED_VALUES) {
      expect(emojiFor(value, value)).toBe('📎');
    }
  });

  it('still classifies by filename extension when the mime type is absent', () => {
    // Normalising an absent mime type to '' rather than bailing out keeps the
    // extension fallback in play: a clip.mp4 with no stored mime type is a video.
    expect(emojiFor(undefined, 'clip.mp4')).toBe('🎥');
    expect(emojiFor(null, 'photo.png')).toBe('🖼️');
    expect(emojiFor(undefined, 'voice.m4a')).toBe('🎵');
    expect(emojiFor(undefined, 'report.pdf')).toBe('📄');
    expect(emojiFor(undefined, 'plan.docx')).toBe('📝');
    expect(emojiFor(undefined, 'marks.xlsx')).toBe('📊');
    expect(emojiFor(undefined, 'deck.pptx')).toBe('📋');
    expect(emojiFor(undefined, 'index.ts')).toBe('💻');
    expect(emojiFor(undefined, 'bundle.zip')).toBe('🗜️');
  });

  it('still classifies by mime type when the filename is absent', () => {
    expect(emojiFor('video/mp4', undefined)).toBe('🎥');
    expect(emojiFor('image/png', null)).toBe('🖼️');
    expect(emojiFor('audio/mpeg', undefined)).toBe('🎵');
    expect(emojiFor('application/pdf', undefined)).toBe('📄');
  });

  it('falls back to the generic file emoji when nothing matches', () => {
    expect(emojiFor(undefined, 'payload.bin')).toBe('📎');
    expect(emojiFor(undefined, 'no-extension')).toBe('📎');
  });
});

describe('getFileTypeEmoji behaviour for valid inputs is unchanged', () => {
  it('classifies well-formed mime type + filename pairs exactly as before', () => {
    expect(emojiFor('image/jpeg', 'photo.jpg')).toBe('🖼️');
    expect(emojiFor('video/quicktime', 'clip.mov')).toBe('🎥');
    expect(emojiFor('audio/wav', 'voice.wav')).toBe('🎵');
    expect(emojiFor('application/pdf', 'report.pdf')).toBe('📄');
    expect(emojiFor('application/msword', 'plan.doc')).toBe('📝');
    expect(emojiFor('application/vnd.oasis.opendocument.spreadsheet', 'marks.xls')).toBe('📊');
    expect(emojiFor('application/vnd.oasis.opendocument.presentation', 'deck.ppt')).toBe('📋');
    expect(emojiFor('text/plain', 'main.py')).toBe('💻');
    expect(emojiFor('application/zip', 'bundle.tar')).toBe('🗜️');
    expect(emojiFor('application/octet-stream', 'payload.bin')).toBe('📎');
  });

  it('lets the mime type win over a mismatched extension, as before', () => {
    expect(emojiFor('video/mp4', 'report.pdf')).toBe('🎥');
    expect(emojiFor('image/png', 'clip.mp4')).toBe('🖼️');
  });
});

describe('extractDisplayName tolerates a malformed sender', () => {
  it('returns the unknown-user placeholder instead of throwing', () => {
    for (const sender of MALFORMED_VALUES) {
      expect(displayNameFor(sender)).toBe('Unknown User');
    }
    expect(displayNameFor('')).toBe('Unknown User');
  });

  it('leaves a valid sender email unchanged', () => {
    expect(displayNameFor('jane.doe@example.com')).toBe('Jane Doe');
    expect(displayNameFor('john_smith@example.com')).toBe('John Smith');
  });
});

describe('the real chat notification path survives a malformed message', () => {
  const RECIPIENT = 'recipient@example.com';
  const CURRENT_USER = 'me@example.com';

  it('delivers a notification for an attachment stored without a fileType', async () => {
    const delivered = jest
      .spyOn(notificationService, 'sendLocalNotification')
      .mockImplementation(async () => {});

    try {
      await notificationService.sendSmartChatNotification(
        {
          id: 'msg-missing-file-type',
          sender: 'sender@example.com',
          timestamp: '2024-01-01T00:00:00.000Z',
          isSpecial: false,
          // A Firestore attachment written without a fileType: the field is
          // declared `string` but simply is not there.
          attachments: [{ url: 'https://example.com/clip.mp4', fileName: 'clip.mp4' }],
        } as any,
        RECIPIENT,
        CURRENT_USER,
        { forceNativeLocal: true }
      );

      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(delivered).toHaveBeenCalledTimes(1);
      // The extension fallback still picked the video emoji.
      expect(delivered.mock.calls[0][0].body).toContain('🎥');
    } finally {
      delivered.mockRestore();
    }
  });

  it('delivers a notification for a message stored without a sender', async () => {
    const delivered = jest
      .spyOn(notificationService, 'sendLocalNotification')
      .mockImplementation(async () => {});

    try {
      await notificationService.sendSmartChatNotification(
        {
          id: 'msg-missing-sender',
          text: 'Hello there',
          timestamp: '2024-01-01T00:00:00.000Z',
          isSpecial: false,
        } as any,
        RECIPIENT,
        CURRENT_USER,
        { forceNativeLocal: true, currentChatPartner: 'someone@example.com' }
      );

      // An unidentifiable sender matches nobody, so the message is still
      // delivered rather than throwing out of the notification path.
      expect(mockLogger.error).not.toHaveBeenCalled();
      expect(delivered).toHaveBeenCalledTimes(1);
      expect(delivered.mock.calls[0][0].body).toContain('Hello there');
    } finally {
      delivered.mockRestore();
    }
  });
});
