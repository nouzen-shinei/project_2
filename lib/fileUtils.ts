import { FileText, Image, Video, Music, Archive, File, FileCode, Database, Presentation, Sheet, BookOpen } from 'lucide-react-native';

export interface FileInfo {
  icon: any;
  color: string;
  category: 'image' | 'video' | 'audio' | 'document' | 'archive' | 'code' | 'database' | 'presentation' | 'spreadsheet' | 'ebook' | 'other';
  canPreview: boolean;
  canPlay: boolean;
  supportedActions: string[];
}

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif', 'tif', 'tiff', 'ico'];
const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'avi', 'wmv', 'flv', 'webm', 'mkv', '3gp'];

/**
 * Attachment metadata (`fileType`, `fileName`) is read back from Firestore /
 * RTDB documents. The TypeScript types describe what writers are supposed to
 * store, not what the stored documents actually contain: an attachment written
 * without a `fileType`, or with a non-string one, arrives here as
 * undefined/null/number. Every classifier below therefore normalises its
 * inputs instead of calling string methods on them directly, so a single
 * malformed document cannot throw and take out attachment rendering.
 *
 * Normalising an absent mime type to '' deliberately keeps the filename
 * extension fallback in play — a `clip.mp4` with no stored mime type is still
 * a video. Behaviour for a valid mime type is unchanged.
 */
const normalizeMimeType = (mimeType: string | null | undefined): string =>
  typeof mimeType === 'string' ? mimeType : '';

/** Lowercased extension of `fileName`, or '' when it is absent/not a string. */
const normalizeExtension = (fileName: string | null | undefined): string =>
  typeof fileName === 'string' ? fileName.split('.').pop()?.toLowerCase() || '' : '';

export const getFileTypeInfo = (mimeType: string | null | undefined, fileName?: string | null): FileInfo => {
  const type = normalizeMimeType(mimeType).toLowerCase();
  const ext = normalizeExtension(fileName);

  // Images
  if (type.startsWith('image/') || IMAGE_EXTENSIONS.includes(ext)) {
    return {
      icon: Image,
      color: '#10B981', // Green
      category: 'image',
      canPreview: true,
      canPlay: false,
      supportedActions: ['preview', 'download', 'share']
    };
  }

  // Videos
  if (type.startsWith('video/') || VIDEO_EXTENSIONS.includes(ext)) {
    return {
      icon: Video,
      color: '#EF4444', // Red
      category: 'video',
      canPreview: true,
      canPlay: true,
      supportedActions: ['preview', 'play', 'download', 'share']
    };
  }

  // Audio
  if (type.startsWith('audio/') || ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'wma'].includes(ext)) {
    return {
      icon: Music,
      color: '#8B5CF6', // Purple
      category: 'audio',
      canPreview: true,
      canPlay: true,
      supportedActions: ['play', 'download', 'share']
    };
  }

  // PDF Documents
  if (type.includes('pdf') || ext === 'pdf') {
    return {
      icon: FileText,
      color: '#DC2626', // Red
      category: 'document',
      canPreview: true,
      canPlay: false,
      supportedActions: ['preview', 'download', 'share']
    };
  }

  // Presentations
  if (
    type.includes('presentation') ||
    ['ppt', 'pptx', 'odp', 'key'].includes(ext)
  ) {
    return {
      icon: Presentation,
      color: '#F59E0B', // Amber
      category: 'presentation',
      canPreview: true,
      canPlay: false,
      supportedActions: ['preview', 'download', 'share']
    };
  }

  // Spreadsheets
  if (
    type.includes('spreadsheet') ||
    ['xls', 'xlsx', 'ods', 'csv', 'numbers'].includes(ext)
  ) {
    return {
      icon: Sheet,
      color: '#059669', // Emerald
      category: 'spreadsheet',
      canPreview: true,
      canPlay: false,
      supportedActions: ['preview', 'download', 'share']
    };
  }

  // Code files
  if (
    type.includes('text/') ||
    ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cpp', 'c', 'html', 'css', 'json', 'xml', 'md', 'yml', 'yaml', 'php', 'rb', 'go', 'rs', 'swift', 'kt'].includes(ext)
  ) {
    return {
      icon: FileCode,
      color: '#7C3AED', // Violet
      category: 'code',
      canPreview: true,
      canPlay: false,
      supportedActions: ['preview', 'download', 'share']
    };
  }

  // Database files
  if (['sql', 'db', 'sqlite', 'sqlite3', 'mdb'].includes(ext)) {
    return {
      icon: Database,
      color: '#0D9488', // Teal
      category: 'database',
      canPreview: false,
      canPlay: false,
      supportedActions: ['download', 'share']
    };
  }

  // E-books
  if (['epub', 'mobi', 'azw', 'azw3', 'fb2'].includes(ext)) {
    return {
      icon: BookOpen,
      color: '#7C2D12', // Brown
      category: 'ebook',
      canPreview: true,
      canPlay: false,
      supportedActions: ['preview', 'download', 'share']
    };
  }

  // Other Documents (Word, RTF, etc.)
  if (
    type.includes('document') ||
    type.includes('text') ||
    ['doc', 'docx', 'txt', 'rtf', 'odt'].includes(ext)
  ) {
    return {
      icon: FileText,
      color: '#3B82F6', // Blue
      category: 'document',
      canPreview: true,
      canPlay: false,
      supportedActions: ['preview', 'download', 'share']
    };
  }

  // Archives
  if (
    type.includes('zip') ||
    type.includes('rar') ||
    type.includes('tar') ||
    type.includes('gzip') ||
    ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)
  ) {
    return {
      icon: Archive,
      color: '#F59E0B', // Amber
      category: 'archive',
      canPreview: false,
      canPlay: false,
      supportedActions: ['download', 'share']
    };
  }

  // Default
  return {
    icon: File,
    color: '#6B7280', // Gray
    category: 'other',
    canPreview: false,
    canPlay: false,
    supportedActions: ['download', 'share']
  };
};

export const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

export const isImageFile = (mimeType: string | null | undefined, fileName?: string | null): boolean => {
  const ext = normalizeExtension(fileName);
  return normalizeMimeType(mimeType).startsWith('image/') || IMAGE_EXTENSIONS.includes(ext);
};

export const isVideoFile = (mimeType: string | null | undefined, fileName?: string | null): boolean => {
  const ext = normalizeExtension(fileName);
  return normalizeMimeType(mimeType).startsWith('video/') || VIDEO_EXTENSIONS.includes(ext);
};

export const isAudioFile = (mimeType: string | null | undefined, fileName?: string | null): boolean => {
  const ext = normalizeExtension(fileName);
  return normalizeMimeType(mimeType).startsWith('audio/') || ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'wma'].includes(ext);
};

export const isPdfFile = (mimeType: string | null | undefined, fileName?: string | null): boolean => {
  const ext = normalizeExtension(fileName);
  return normalizeMimeType(mimeType).includes('pdf') || ext === 'pdf';
};

export const isCodeFile = (mimeType: string | null | undefined, fileName?: string | null): boolean => {
  const ext = normalizeExtension(fileName);
  return normalizeMimeType(mimeType).includes('text/') || 
    ['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cpp', 'c', 'html', 'css', 'json', 'xml', 'md', 'yml', 'yaml', 'php', 'rb', 'go', 'rs', 'swift', 'kt'].includes(ext);
};

export const isPresentationFile = (mimeType: string | null | undefined, fileName?: string | null): boolean => {
  const ext = normalizeExtension(fileName);
  return normalizeMimeType(mimeType).includes('presentation') || ['ppt', 'pptx', 'odp', 'key'].includes(ext);
};

export const isSpreadsheetFile = (mimeType: string | null | undefined, fileName?: string | null): boolean => {
  const ext = normalizeExtension(fileName);
  return normalizeMimeType(mimeType).includes('spreadsheet') || ['xls', 'xlsx', 'ods', 'csv', 'numbers'].includes(ext);
};

export const isEbookFile = (mimeType: string | null | undefined, fileName?: string | null): boolean => {
  const ext = normalizeExtension(fileName);
  return ['epub', 'mobi', 'azw', 'azw3', 'fb2'].includes(ext);
};

export const canPreview = (mimeType: string | null | undefined, fileName?: string | null): boolean => {
  const fileInfo = getFileTypeInfo(mimeType, fileName);
  return fileInfo.canPreview;
};

export const canPlay = (mimeType: string | null | undefined, fileName?: string | null): boolean => {
  const fileInfo = getFileTypeInfo(mimeType, fileName);
  return fileInfo.canPlay;
};

export const getMimeTypeFromFileName = (fileName: string | null | undefined): string => {
  const ext = normalizeExtension(fileName);
  
  const mimeMap: Record<string, string> = {
    // Images
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'bmp': 'image/bmp',
    
    // Videos
    'mp4': 'video/mp4',
    'avi': 'video/x-msvideo',
    'mov': 'video/quicktime',
    'wmv': 'video/x-ms-wmv',
    'flv': 'video/x-flv',
    'webm': 'video/webm',
    'mkv': 'video/x-matroska',
    
    // Audio
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'flac': 'audio/flac',
    'm4a': 'audio/mp4',
    'aac': 'audio/aac',
    'ogg': 'audio/ogg',
    'wma': 'audio/x-ms-wma',
    
    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'txt': 'text/plain',
    'rtf': 'application/rtf',
    
    // Presentations
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'odp': 'application/vnd.oasis.opendocument.presentation',
    
    // Spreadsheets
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ods': 'application/vnd.oasis.opendocument.spreadsheet',
    'csv': 'text/csv',
    
    // Code
    'js': 'text/javascript',
    'ts': 'text/typescript',
    'html': 'text/html',
    'css': 'text/css',
    'json': 'application/json',
    'xml': 'text/xml',
    'md': 'text/markdown',
    'py': 'text/x-python',
    'java': 'text/x-java-source',
    
    // Archives
    'zip': 'application/zip',
    'rar': 'application/x-rar-compressed',
    '7z': 'application/x-7z-compressed',
    'tar': 'application/x-tar',
    'gz': 'application/gzip',
  };
  
  return mimeMap[ext] || 'application/octet-stream';
};
