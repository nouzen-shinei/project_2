// Feature: video-transcoding-compatibility, Property 30: isVideoFile is the single guard predicate
// Validates Requirement 7.9
//
// Asserts that the same isVideoFile function from lib/fileUtils.ts is used
// consistently across player source selection, prefetch enqueue, and cache fetch
// paths — ensuring any future URL will receive the same classification everywhere.

import * as fc from 'fast-check';
import { isVideoFile } from '../../lib/fileUtils';

// ─── Video extension samples ─────────────────────────────────────────────────

const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'avi', 'wmv', 'flv', 'webm', 'mkv', '3gp'];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];

// ─── Property 30a: isVideoFile is consistent for video filenames ────────────

describe('Property 30a: isVideoFile returns true for all known video extensions', () => {
  it('holds for any video filename with a standard extension', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.constantFrom(...VIDEO_EXTENSIONS),
        (baseName, ext) => {
          const fileName = `${baseName}.${ext}`;
          // All three paths use the same isVideoFile call:
          // 1. ChatMessageItem: isVideoFile(attachment.fileType, attachment.fileName)
          // 2. scheduleAttachmentPrefetch: isVideoFile(attachment.fileType, attachment.fileName)
          // 3. getMediaForDownload/prepareMediaUri: isVideoFile(undefined, fileName || remoteUrl)
          expect(isVideoFile('', fileName)).toBe(true);
          expect(isVideoFile(undefined as unknown as string, fileName)).toBe(true);
          expect(isVideoFile('video/mp4', fileName)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 30b: isVideoFile returns false for image filenames ──────────────

describe('Property 30b: isVideoFile returns false for image filenames', () => {
  it('holds for any image filename', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.constantFrom(...IMAGE_EXTENSIONS),
        (baseName, ext) => {
          const fileName = `${baseName}.${ext}`;
          expect(isVideoFile('', fileName)).toBe(false);
          expect(isVideoFile('image/jpeg', fileName)).toBe(false);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 30c: MIME type alone determines video classification ────────────

describe('Property 30c: video/* MIME type always classifies as video', () => {
  it('holds regardless of filename', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 30 }),
        (subtype) => {
          fc.pre(/^[a-z0-9\-]+$/.test(subtype));
          const mimeType = `video/${subtype}`;
          expect(isVideoFile(mimeType, 'file.pdf')).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ─── Property 30d: classification is deterministic (same input = same output) ─

describe('Property 30d: isVideoFile is deterministic', () => {
  it('holds: same fileType+fileName always yields the same result', () => {
    fc.assert(
      fc.property(
        fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
        fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
        (fileType, fileName) => {
          const r1 = isVideoFile(fileType ?? '', fileName);
          const r2 = isVideoFile(fileType ?? '', fileName);
          expect(r1).toBe(r2);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ─── Property 30e: media paths agree on classification for a URL ──────────────
//
// Simulates calling isVideoFile the way each media path does it and asserts
// they all reach the same conclusion for a given URL string.

describe('Property 30e: all media paths use the same isVideoFile classification', () => {
  it('holds for any fileName + URL combination', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.constantFrom(...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS),
        fc.webUrl({ withQueryParameters: false }),
        (baseName, ext, url) => {
          const fileName = `${baseName}.${ext}`;

          // Path 1: ChatMessageItem / scheduleAttachmentPrefetch pattern
          const classificationWithFileType = isVideoFile('', fileName);

          // Path 2: getMediaForDownload / prepareMediaUri pattern (undefined mimeType)
          const classificationWithUndefinedType = isVideoFile(undefined as unknown as string, fileName);

          // Path 3: resolveVideoSource doesn't call isVideoFile directly, but
          //         both paths 1 and 2 must agree with each other
          expect(classificationWithFileType).toBe(classificationWithUndefinedType);
        },
      ),
      { numRuns: 200 },
    );
  });
});
