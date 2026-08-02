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

// ── displayName (upload-idempotency spec, background-transport gap) ───────────
//
// `filename` used to be BOTH the object-path seed and the user-visible name. The
// native background transport now sends a DETERMINISTIC `filename` derived from
// the send's `clientMsgId`, so the real name arrives separately as `displayName`
// and must win every user-visible label. With `displayName` absent the output has
// to stay byte-identical to the cases above — that is what keeps every deployed
// caller unaffected.
describe('buildBackgroundUploadChatMessageInput — displayName', () => {
  /** What the background transport actually sends: a machine storage name + the real name. */
  const deterministic = {
    ...common,
    filename: 'pick_pm_1712345678901_abc123_0k1j2h3g4f5d6s.jpg',
    displayName: 'IMG_0042.jpg',
  };

  it('uses displayName for the sticker name when present', () => {
    const input = buildBackgroundUploadChatMessageInput({ ...deterministic, mediaKind: 'sticker' });
    expect(input.sticker).toEqual({ url: common.url, name: 'IMG_0042.jpg' });
    // The deterministic storage name must not leak into what the recipient sees.
    expect(input.sticker?.name).not.toContain('pick_pm_');
  });

  it('uses displayName for the attachment fileName when present', () => {
    const input = buildBackgroundUploadChatMessageInput({ ...deterministic, mediaKind: 'attachment' });
    expect(input.attachments).toEqual([
      { url: common.url, fileName: 'IMG_0042.jpg', fileType: 'image/png', fileSize: 2048 },
    ]);
  });

  it('ignores displayName for a gif (no name field on that payload)', () => {
    const input = buildBackgroundUploadChatMessageInput({ ...deterministic, mediaKind: 'gif' });
    expect(input.gif).toEqual({ url: common.url });
    expect(input.sticker).toBeUndefined();
    expect(input.attachments).toBeUndefined();
  });

  it('falls back to filename for every mediaKind when displayName is absent or blank', () => {
    for (const displayName of [undefined, ''] as const) {
      const sticker = buildBackgroundUploadChatMessageInput({ ...common, displayName, mediaKind: 'sticker' });
      expect(sticker.sticker?.name).toBe(common.filename);

      const attachment = buildBackgroundUploadChatMessageInput({ ...common, displayName, mediaKind: 'attachment' });
      expect(attachment.attachments?.[0].fileName).toBe(common.filename);

      const gif = buildBackgroundUploadChatMessageInput({ ...common, displayName, mediaKind: 'gif' });
      expect(gif.gif).toEqual({ url: common.url });
    }
  });

  it('still reaches the Sticker / file.{ext} fallbacks when BOTH names are empty', () => {
    // The `|| 'Sticker'` and `|| file.${safeExt}` branches must survive the split:
    // an empty displayName degrades to filename, and an empty filename degrades to
    // the synthesized name — exactly as before this parameter existed.
    for (const displayName of [undefined, ''] as const) {
      const sticker = buildBackgroundUploadChatMessageInput({
        ...common,
        filename: '',
        displayName,
        mediaKind: 'sticker',
      });
      expect(sticker.sticker?.name).toBe('Sticker');

      const attachment = buildBackgroundUploadChatMessageInput({
        ...common,
        filename: '',
        displayName,
        mediaKind: 'attachment',
      });
      expect(attachment.attachments?.[0].fileName).toBe('file.png');
    }
  });

  it('lets displayName rescue an empty filename (no Sticker / file.{ext} fallback)', () => {
    const sticker = buildBackgroundUploadChatMessageInput({
      ...common,
      filename: '',
      displayName: 'my_sticker.png',
      mediaKind: 'sticker',
    });
    expect(sticker.sticker?.name).toBe('my_sticker.png');

    const attachment = buildBackgroundUploadChatMessageInput({
      ...common,
      filename: '',
      displayName: 'notes.pdf',
      mediaKind: 'attachment',
    });
    expect(attachment.attachments?.[0].fileName).toBe('notes.pdf');
  });

  it('is byte-identical to the no-displayName build for every mediaKind', () => {
    // The backward-compatibility property, asserted on the whole payload rather
    // than one field: adding an absent optional parameter changes nothing.
    for (const mediaKind of ['sticker', 'gif', 'attachment'] as const) {
      const withoutParam = buildBackgroundUploadChatMessageInput({ ...common, mediaKind });
      const withUndefined = buildBackgroundUploadChatMessageInput({ ...common, displayName: undefined, mediaKind });
      const withBlank = buildBackgroundUploadChatMessageInput({ ...common, displayName: '', mediaKind });
      expect(withUndefined).toEqual(withoutParam);
      expect(withBlank).toEqual(withoutParam);
    }
  });

  it('leaves every non-name field untouched when displayName is used', () => {
    const input = buildBackgroundUploadChatMessageInput({ ...deterministic, mediaKind: 'attachment' });
    expect(input.senderEmail).toBe('sender@example.com');
    expect(input.recipientEmail).toBe('recipient@example.com');
    expect(input.tenantId).toBe('tenant-1');
    expect(input.clientMsgId).toBe('pm_abc123');
    expect(input.attachments?.[0].url).toBe(common.url);
    expect(input.attachments?.[0].fileType).toBe('image/png');
    expect(input.attachments?.[0].fileSize).toBe(2048);
  });
});
