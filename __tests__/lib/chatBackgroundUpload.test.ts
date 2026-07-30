// Mock Platform as web so the module's guarded native require is skipped and the
// pure URL builder can be imported without the native TurboModule.
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));
jest.mock('@/lib/logger', () => ({ logger: { warn: jest.fn(), error: jest.fn(), debug: jest.fn(), info: jest.fn() } }));

import {
  buildBackgroundUploadUrl,
  isBackgroundUploadEnabled,
  backgroundUploadDiagnostics,
} from '../../lib/chatBackgroundUpload';

const base = {
  tenantId: 't1',
  conversationFolder: 'c_abc',
  fileName: 'sticker_1.png',
  clientMsgId: 'pm_1',
  recipientId: 'r@example.com',
  mediaKind: 'sticker' as const,
};

describe('buildBackgroundUploadUrl', () => {
  it('targets /storage/upload with createMessage + all message params', () => {
    const u = new URL(buildBackgroundUploadUrl('https://api.example.com', base));
    expect(u.origin + u.pathname).toBe('https://api.example.com/storage/upload');
    expect(u.searchParams.get('tenantId')).toBe('t1');
    expect(u.searchParams.get('purpose')).toBe('chat');
    expect(u.searchParams.get('conversationFolder')).toBe('c_abc');
    expect(u.searchParams.get('filename')).toBe('sticker_1.png');
    expect(u.searchParams.get('createMessage')).toBe('1');
    expect(u.searchParams.get('clientMsgId')).toBe('pm_1');
    expect(u.searchParams.get('recipientId')).toBe('r@example.com');
    expect(u.searchParams.get('mediaKind')).toBe('sticker');
  });

  it('omits messageText unless provided', () => {
    expect(new URL(buildBackgroundUploadUrl('https://api.example.com', base)).searchParams.get('messageText')).toBeNull();
    const withText = new URL(buildBackgroundUploadUrl('https://api.example.com', { ...base, text: 'hi there' }));
    expect(withText.searchParams.get('messageText')).toBe('hi there');
  });

  it('trims a trailing slash on the base url (no double slash)', () => {
    const u = new URL(buildBackgroundUploadUrl('https://api.example.com/', base));
    expect(u.pathname).toBe('/storage/upload');
  });

  it('url-encodes special characters in params', () => {
    const u = new URL(
      buildBackgroundUploadUrl('https://api.example.com', { ...base, recipientId: 'a b@x.com', fileName: 'my file.png' })
    );
    expect(u.searchParams.get('recipientId')).toBe('a b@x.com');
    expect(u.searchParams.get('filename')).toBe('my file.png');
  });

  it('reports background upload disabled on web', () => {
    expect(isBackgroundUploadEnabled()).toBe(false);
  });
});

describe('backgroundUploadDiagnostics', () => {
  it('reports why background upload is disabled on web (module absent, not enabled)', () => {
    const diag = backgroundUploadDiagnostics();
    expect(diag.platform).toBe('web');
    // The guarded native require is skipped on web, so the module never loads.
    expect(diag.moduleLoaded).toBe(false);
    expect(diag.hasStartUpload).toBe(false);
    expect(diag.enabled).toBe(false);
    // Mirrors isBackgroundUploadEnabled()'s result.
    expect(diag.enabled).toBe(isBackgroundUploadEnabled());
  });
});
