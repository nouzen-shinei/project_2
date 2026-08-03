// Unit tests: lib/fileUtils classifiers are total for malformed attachment metadata.
//
// Attachment `fileType` / `fileName` are typed `string` but read back from
// Firestore/RTDB documents, so the type is a claim the stored data does not have
// to honour. A stored attachment written without a `fileType` used to make every
// classifier throw ("Cannot read properties of undefined (reading 'startsWith')"),
// taking attachment rendering, prefetch enqueue and cache fetch down with it.
//
// These tests pin two things:
//   1. no classifier throws for a nullish / non-string mime type
//   2. the filename-extension fallback still decides the answer in that case
//      (absent mime type is not the same as "not a video")

import {
  getFileTypeInfo,
  isImageFile,
  isVideoFile,
  isAudioFile,
  isPdfFile,
  isCodeFile,
  isPresentationFile,
  isSpreadsheetFile,
  isEbookFile,
  canPreview,
  canPlay,
  getMimeTypeFromFileName,
} from '../../lib/fileUtils';

// Values a Firestore document can realistically produce for a field the type
// system insists is a `string`.
const MALFORMED_MIME_TYPES = [undefined, null, 42, {}, []] as unknown as string[];

const PREDICATES: Array<[string, (mimeType: string, fileName?: string) => boolean]> = [
  ['isImageFile', isImageFile],
  ['isVideoFile', isVideoFile],
  ['isAudioFile', isAudioFile],
  ['isPdfFile', isPdfFile],
  ['isCodeFile', isCodeFile],
  ['isPresentationFile', isPresentationFile],
  ['isSpreadsheetFile', isSpreadsheetFile],
  ['isEbookFile', isEbookFile],
  ['canPreview', canPreview],
  ['canPlay', canPlay],
];

describe('fileUtils classifiers tolerate a missing mime type', () => {
  it.each(PREDICATES)('%s does not throw for nullish or non-string mimeType', (_name, predicate) => {
    for (const mimeType of MALFORMED_MIME_TYPES) {
      expect(typeof predicate(mimeType, 'clip.mp4')).toBe('boolean');
      expect(typeof predicate(mimeType, undefined)).toBe('boolean');
    }
  });

  it('getFileTypeInfo does not throw for nullish or non-string mimeType', () => {
    for (const mimeType of MALFORMED_MIME_TYPES) {
      expect(getFileTypeInfo(mimeType, 'clip.mp4').category).toBe('video');
      expect(getFileTypeInfo(mimeType, undefined).category).toBe('other');
    }
  });

  it('getMimeTypeFromFileName does not throw for a nullish fileName', () => {
    expect(getMimeTypeFromFileName(undefined as unknown as string)).toBe('application/octet-stream');
    expect(getMimeTypeFromFileName(null as unknown as string)).toBe('application/octet-stream');
    expect(getMimeTypeFromFileName('clip.mp4')).toBe('video/mp4');
  });
});

describe('fileUtils falls back to the filename extension when the mime type is absent', () => {
  it('classifies by extension for a missing mime type', () => {
    expect(isVideoFile(undefined as unknown as string, 'clip.mp4')).toBe(true);
    expect(isImageFile(undefined as unknown as string, 'photo.png')).toBe(true);
    expect(isAudioFile(undefined as unknown as string, 'voice.m4a')).toBe(true);
    expect(isPdfFile(undefined as unknown as string, 'report.pdf')).toBe(true);
  });

  it('returns false when neither the mime type nor the extension matches', () => {
    expect(isVideoFile(undefined as unknown as string, 'photo.png')).toBe(false);
    expect(isVideoFile(undefined as unknown as string, 'no-extension')).toBe(false);
  });

  it('leaves valid mime type behaviour unchanged', () => {
    expect(isVideoFile('video/mp4', 'report.pdf')).toBe(true);
    expect(isImageFile('image/jpeg', 'report.pdf')).toBe(true);
    expect(isVideoFile('image/jpeg', 'photo.png')).toBe(false);
    expect(getFileTypeInfo('video/quicktime', 'clip.mov').category).toBe('video');
  });
});
