// Feature: video-transcoding-compatibility
// Unit tests for resolveVideoSource (Requirement 7.2)

import { resolveVideoSource, type VideoAttachmentSource } from '../../lib/videoSource';

const ORIGINAL_URL = 'https://firebasestorage.googleapis.com/v0/b/bucket/o/chat-files%2Fvideo.mp4?alt=media&token=abc';
const TRANSCODED_URL = 'https://firebasestorage.googleapis.com/v0/b/bucket/o/chat-files%2Fvideo_h264.mp4?alt=media&token=xyz';

describe('resolveVideoSource', () => {
  describe('when transcodedUrl is present and non-empty', () => {
    it('returns transcodedUrl as source', () => {
      const att: VideoAttachmentSource = {
        url: ORIGINAL_URL,
        transcodedUrl: TRANSCODED_URL,
      };
      const result = resolveVideoSource(att);
      expect(result.source).toBe(TRANSCODED_URL);
    });

    it('sets originalMayBeDeleted to true', () => {
      const att: VideoAttachmentSource = {
        url: ORIGINAL_URL,
        transcodedUrl: TRANSCODED_URL,
      };
      const result = resolveVideoSource(att);
      expect(result.originalMayBeDeleted).toBe(true);
    });

    it('trims whitespace from transcodedUrl', () => {
      const att: VideoAttachmentSource = {
        url: ORIGINAL_URL,
        transcodedUrl: `  ${TRANSCODED_URL}  `,
      };
      const result = resolveVideoSource(att);
      expect(result.source).toBe(TRANSCODED_URL);
    });

    it('ignores originalReplaced when transcodedUrl is present', () => {
      const att: VideoAttachmentSource = {
        url: ORIGINAL_URL,
        transcodedUrl: TRANSCODED_URL,
        originalReplaced: false,
      };
      const result = resolveVideoSource(att);
      expect(result.source).toBe(TRANSCODED_URL);
      expect(result.originalMayBeDeleted).toBe(true);
    });
  });

  describe('when transcodedUrl is absent or empty', () => {
    it('returns url as source when transcodedUrl is undefined', () => {
      const att: VideoAttachmentSource = { url: ORIGINAL_URL };
      const result = resolveVideoSource(att);
      expect(result.source).toBe(ORIGINAL_URL);
    });

    it('returns url as source when transcodedUrl is empty string', () => {
      const att: VideoAttachmentSource = { url: ORIGINAL_URL, transcodedUrl: '' };
      const result = resolveVideoSource(att);
      expect(result.source).toBe(ORIGINAL_URL);
    });

    it('returns url as source when transcodedUrl is whitespace-only', () => {
      const att: VideoAttachmentSource = { url: ORIGINAL_URL, transcodedUrl: '   ' };
      const result = resolveVideoSource(att);
      expect(result.source).toBe(ORIGINAL_URL);
    });

    it('sets originalMayBeDeleted to false', () => {
      const att: VideoAttachmentSource = { url: ORIGINAL_URL };
      const result = resolveVideoSource(att);
      expect(result.originalMayBeDeleted).toBe(false);
    });
  });

  describe('when originalReplaced is true and no transcodedUrl', () => {
    it('returns url (which backend already set to H.264)', () => {
      const att: VideoAttachmentSource = {
        url: TRANSCODED_URL, // backend already overwrote url
        originalReplaced: true,
      };
      const result = resolveVideoSource(att);
      expect(result.source).toBe(TRANSCODED_URL);
    });

    it('sets originalMayBeDeleted to false (url is already the safe copy)', () => {
      const att: VideoAttachmentSource = {
        url: TRANSCODED_URL,
        originalReplaced: true,
      };
      const result = resolveVideoSource(att);
      expect(result.originalMayBeDeleted).toBe(false);
    });
  });

  describe('return value integrity', () => {
    it('always returns a non-empty source string', () => {
      const cases: VideoAttachmentSource[] = [
        { url: ORIGINAL_URL },
        { url: ORIGINAL_URL, transcodedUrl: TRANSCODED_URL },
        { url: ORIGINAL_URL, transcodedUrl: '' },
      ];
      for (const att of cases) {
        const result = resolveVideoSource(att);
        expect(typeof result.source).toBe('string');
        expect(result.source.length).toBeGreaterThan(0);
      }
    });

    it('always returns a boolean originalMayBeDeleted', () => {
      const cases: VideoAttachmentSource[] = [
        { url: ORIGINAL_URL },
        { url: ORIGINAL_URL, transcodedUrl: TRANSCODED_URL },
      ];
      for (const att of cases) {
        const result = resolveVideoSource(att);
        expect(typeof result.originalMayBeDeleted).toBe('boolean');
      }
    });

    it('has no side effects — same input always produces same output', () => {
      const att: VideoAttachmentSource = {
        url: ORIGINAL_URL,
        transcodedUrl: TRANSCODED_URL,
      };
      const r1 = resolveVideoSource(att);
      const r2 = resolveVideoSource(att);
      expect(r1).toEqual(r2);
    });
  });
});
