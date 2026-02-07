import { logger } from '@/lib/logger';
// File download utility with CORS support
// This handles proper file downloads for web by fetching as blob

import { Platform } from 'react-native';

export type FileAvailability = 'ok' | 'missing' | 'unknown';

const deriveFileNameFromUrl = (url: string): string | null => {
  const raw = (url || '').trim();
  if (!raw) return null;

  try {
    const u = new URL(raw);

    // Firebase download URL form: /v0/b/<bucket>/o/<encodedObjectPath>
    const idx = u.pathname.indexOf('/o/');
    if (idx >= 0) {
      const encoded = u.pathname.slice(idx + 3);
      const objectPath = decodeURIComponent(encoded);
      const parts = objectPath.split('/').filter(Boolean);
      const last = parts[parts.length - 1];
      return last ? last.trim() : null;
    }

    // GCS form: https://storage.googleapis.com/<bucket>/<path>
    const pathParts = u.pathname.split('/').filter(Boolean);
    const last = pathParts[pathParts.length - 1];
    return last ? decodeURIComponent(last).trim() : null;
  } catch {
    const noQuery = raw.split('?')[0];
    const parts = noQuery.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    return last ? decodeURIComponent(last).trim() : null;
  }
};

const looksLikeGarbageFileName = (value?: string | null): boolean => {
  const v = (value || '').trim();
  if (!v) return true;
  if (/^https?:\/\//i.test(v)) return true;
  if (v.includes('?') || v.includes('&') || v.includes('token=')) return true;
  if (/%2f/i.test(v)) return true;
  return false;
};

const normalizeDownloadFileName = (input: { fileUrl: string; fileName?: string }): string => {
  const provided = (input.fileName || '').trim();
  if (!looksLikeGarbageFileName(provided)) return provided;

  const derived = deriveFileNameFromUrl(input.fileUrl);
  if (derived) return derived;

  return provided || '';
};

export const FileDownloadUtil = {
  // Helper function to extract clean filename from URL or provided name
  extractCleanFileName(fileUrl: string, providedFileName?: string): string {
    let cleanName = normalizeDownloadFileName({ fileUrl, fileName: providedFileName });
    
    // If no provided filename or it contains URL artifacts, extract from URL
    if (!cleanName || cleanName.includes('%2F') || cleanName.includes('alt=media') || cleanName.includes('token=')) {
      try {
        // Parse the URL to get the path
        const url = new URL(fileUrl);
        const pathParts = url.pathname.split('/');
        
        // Find the part that looks like a filename (contains an underscore and looks like a filename)
        for (const part of pathParts) {
          const decoded = decodeURIComponent(part);
          // Look for parts that contain file extensions or look like filenames
          if (decoded.match(/\.(jpg|jpeg|png|gif|pdf|doc|docx|txt|mp4|mov|avi|mkv|webm|m4v|3gp|wmv|mp3|zip|rar|xlsx|xls|ppt|pptx)$/i)) {
            cleanName = decoded;
            break;
          }
          // Also check for parts that look like timestamped filenames
          if (decoded.match(/^\d+_.*\./)) {
            cleanName = decoded;
            break;
          }
        }
        
        // If still no good filename found, use the shared normalizer heuristics.
        if (!cleanName || looksLikeGarbageFileName(cleanName)) {
          const derived = deriveFileNameFromUrl(fileUrl);
          if (derived) {
            cleanName = derived;
          }
        }
      } catch (error) {
        logger.warn('Failed to parse URL for filename:', error);
      }
    }
    
    // Final cleanup - remove any remaining URL artifacts
    cleanName = cleanName
      .replace(/^.*%2F/, '') // Remove path prefixes
      .replace(/\?.*$/, '')   // Remove query parameters
      .replace(/&.*$/, '')    // Remove additional parameters
      .replace(/_alt=media.*$/, '') // Remove Firebase storage parameters
      .trim();
    
    // If we still don't have a good filename, create a default one
    if (!cleanName || cleanName.length < 3) {
      const timestamp = Date.now();
      cleanName = `downloaded_file_${timestamp}.bin`;
    }
    
    return cleanName;
  },

  async downloadFile(fileUrl: string, fileName: string): Promise<boolean> {
    if (Platform.OS !== 'web') {
      // For mobile, delegate to the existing mobile implementation
      return false; // Indicates that mobile should handle this differently
    }

    try {
      // Clean the filename first
      const cleanFileName = this.extractCleanFileName(fileUrl, fileName);

      if (fileUrl.startsWith('blob:') || fileUrl.startsWith('data:')) {
        const link = document.createElement('a');
        link.href = fileUrl;
        link.download = cleanFileName;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return true;
      }
      
      // Fetch the file as a blob to bypass CORS issues with direct download
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const blob = await response.blob();
      
      // Create object URL from blob
      const objectUrl = URL.createObjectURL(blob);
      
      // Create download link
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = cleanFileName;
      link.style.display = 'none';
      
      // Add to document, click, and clean up
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      
      return true;
    } catch (error) {
      logger.error('Download failed:', error);
      throw error;
    }
  },

  async downloadFileWithProgress(
    fileUrl: string,
    fileName: string,
    onProgress?: (percent: number) => void
  ): Promise<boolean> {
    if (Platform.OS !== 'web') {
      return false;
    }

    const reportProgress = (percent: number) => {
      if (!onProgress) return;
      const bounded = Math.max(0, Math.min(100, Math.round(percent)));
      onProgress(bounded);
    };

    try {
      const cleanFileName = this.extractCleanFileName(fileUrl, fileName);

      if (fileUrl.startsWith('blob:') || fileUrl.startsWith('data:')) {
        reportProgress(100);
        const link = document.createElement('a');
        link.href = fileUrl;
        link.download = cleanFileName;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        return true;
      }

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const totalBytes = Number(response.headers.get('content-length') || 0);
      const hasStream = Boolean(response.body && typeof response.body.getReader === 'function');

      if (!hasStream) {
        const blobFallback = await response.blob();
        reportProgress(100);
        const objectUrl = URL.createObjectURL(blobFallback);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = cleanFileName;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
        return true;
      }

      const reader = response.body!.getReader();
      const chunks: Uint8Array[] = [];
      let receivedBytes = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          receivedBytes += value.length;
          if (totalBytes > 0) {
            const pct = Math.floor((receivedBytes / totalBytes) * 100);
            reportProgress(Math.min(99, pct));
          }
        }
      }

      const blobParts = chunks.map((chunk) => Uint8Array.from(chunk));
      const blob = new Blob(blobParts);
      reportProgress(100);
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = cleanFileName;
      link.style.display = 'none';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      return true;
    } catch (error) {
      logger.error('Download failed:', error);
      throw error;
    }
  },

  async checkFileAccessibility(fileUrl: string): Promise<boolean> {
    const availability = await this.checkFileAvailability(fileUrl);
    return availability === 'ok';
  },

  async checkFileAvailability(
    fileUrl: string,
    options?: { timeoutMs?: number }
  ): Promise<FileAvailability> {
    if (fileUrl.startsWith('blob:') || fileUrl.startsWith('data:')) {
      return 'ok';
    }
    try {
      const controller = new AbortController();
      const timeoutMs = Math.max(0, options?.timeoutMs ?? 0);
      const timeoutId = timeoutMs
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;

      const response = await fetch(fileUrl, { method: 'HEAD', signal: controller.signal });

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (response.ok) {
        return 'ok';
      }

      if (response.status === 404 || response.status === 410) {
        return 'missing';
      }

      return 'unknown';
    } catch (error) {
      return 'unknown';
    }
  }
};
