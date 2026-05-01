export interface ChatAttachmentAutoTextFile {
  fileType?: string | null;
  fileName?: string | null;
}

type ChatAttachmentKind = 'image' | 'video' | 'audio' | 'file';

const IMAGE_EXTENSIONS = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'svg',
  'heic',
  'heif',
  'tif',
  'tiff',
  'ico',
]);

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'm4v',
  'avi',
  'wmv',
  'flv',
  'webm',
  'mkv',
  '3gp',
]);

const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'flac',
  'm4a',
  'aac',
  'ogg',
  'wma',
]);

function normalizeMimeType(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  const baseType = value.split(';')[0] || '';
  return baseType.trim().toLowerCase();
}

function normalizeFileName(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase();
}

function resolveExtension(fileName: string): string {
  if (!fileName) {
    return '';
  }

  const lastDotIndex = fileName.lastIndexOf('.');
  if (lastDotIndex <= 0 || lastDotIndex >= fileName.length - 1) {
    return '';
  }

  return fileName.slice(lastDotIndex + 1);
}

function resolveAttachmentKind(file: ChatAttachmentAutoTextFile): ChatAttachmentKind {
  const mimeType = normalizeMimeType(file?.fileType);
  const extension = resolveExtension(normalizeFileName(file?.fileName));

  if (mimeType.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) {
    return 'image';
  }

  if (mimeType.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) {
    return 'video';
  }

  if (mimeType.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) {
    return 'audio';
  }

  return 'file';
}

export function resolveChatAttachmentAutoText(input: {
  text?: string | null;
  files?: ChatAttachmentAutoTextFile[] | null;
}): string {
  const providedText = typeof input?.text === 'string' ? input.text : '';
  if (providedText.trim().length > 0) {
    return providedText;
  }

  const files = Array.isArray(input?.files) ? input.files : [];
  if (files.length <= 0) {
    return providedText;
  }

  if (files.length === 1) {
    const kind = resolveAttachmentKind(files[0]);
    if (kind === 'image') {
      return 'Sent an image';
    }
    if (kind === 'video') {
      return 'Sent a video';
    }
    if (kind === 'audio') {
      return 'Sent an audio file';
    }
    return 'Sent a file';
  }

  let imageCount = 0;
  let videoCount = 0;
  let audioCount = 0;
  let fileCount = 0;

  for (const file of files) {
    const kind = resolveAttachmentKind(file);
    if (kind === 'image') {
      imageCount += 1;
      continue;
    }
    if (kind === 'video') {
      videoCount += 1;
      continue;
    }
    if (kind === 'audio') {
      audioCount += 1;
      continue;
    }
    fileCount += 1;
  }

  const parts: string[] = [];
  if (imageCount > 0) {
    parts.push(`${imageCount} image${imageCount > 1 ? 's' : ''}`);
  }
  if (videoCount > 0) {
    parts.push(`${videoCount} video${videoCount > 1 ? 's' : ''}`);
  }
  if (audioCount > 0) {
    parts.push(`${audioCount} audio file${audioCount > 1 ? 's' : ''}`);
  }
  if (fileCount > 0) {
    parts.push(`${fileCount} file${fileCount > 1 ? 's' : ''}`);
  }

  if (parts.length <= 0) {
    return 'Sent files';
  }

  return `Sent ${parts.join(', ')}`;
}
