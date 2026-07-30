import { buildBackgroundUploadChatMessageInput } from '../lib/backgroundUploadMessage';

const common = {
  url: 'https://firebasestorage.googleapis.com/v0/b/bkt/o/chat-files%2Ft%2Fc_abc%2F123_file.png?alt=media&token=tok',
  filename: 'sticker_123.png',
  contentType: 'image/png',
  bytes: 2048,
  safeExt: 'png',
  senderEmail: 'sender@example.com',
  recipientId: 'recipient@example.com',
  tenantId: 'tenant-1',
  clientMsgId: 'pm_abc123',
  text: '',
};

describe('buildBackgroundUploadChatMessageInput', () => {
  it('carries sender/recipient/tenant/clientMsgId onto every kind', () => {
    for (const mediaKind of ['sticker', 'gif', 'attachment'] as const) {
      const input = buildBackgroundUploadChatMessageInput({ ...common, mediaKind });
      expect(input.senderEmail).toBe('sender@example.com');
      expect(input.recipientEmail).toBe('recipient@example.com');
      expect(input.tenantId).toBe('tenant-1');
      expect(input.clientMsgId).toBe('pm_abc123');
      expect(input.text).toBe('');
    }
  });

  it('maps mediaKind "sticker" to a sticker payload (and no gif/attachments)', () => {
    const input = buildBackgroundUploadChatMessageInput({ ...common, mediaKind: 'sticker' });
    expect(input.sticker).toEqual({ url: common.url, name: 'sticker_123.png' });
    expect(input.gif).toBeUndefined();
    expect(input.attachments).toBeUndefined();
  });

  it('maps mediaKind "gif" to a gif payload', () => {
    const input = buildBackgroundUploadChatMessageInput({ ...common, mediaKind: 'gif' });
    expect(input.gif).toEqual({ url: common.url });
    expect(input.sticker).toBeUndefined();
    expect(input.attachments).toBeUndefined();
  });

  it('maps mediaKind "attachment" to a single attachment with file metadata', () => {
    const input = buildBackgroundUploadChatMessageInput({ ...common, mediaKind: 'attachment' });
    expect(input.attachments).toEqual([
      { url: common.url, fileName: 'sticker_123.png', fileType: 'image/png', fileSize: 2048 },
    ]);
    expect(input.sticker).toBeUndefined();
    expect(input.gif).toBeUndefined();
  });

  it('falls back to synthesized names when filename is empty', () => {
    const sticker = buildBackgroundUploadChatMessageInput({ ...common, filename: '', mediaKind: 'sticker' });
    expect(sticker.sticker?.name).toBe('Sticker');
    const attachment = buildBackgroundUploadChatMessageInput({ ...common, filename: '', mediaKind: 'attachment' });
    expect(attachment.attachments?.[0].fileName).toBe('file.png');
  });

  it('defaults text to empty string when omitted', () => {
    const input = buildBackgroundUploadChatMessageInput({ ...common, text: undefined, mediaKind: 'gif' });
    expect(input.text).toBe('');
  });
});
