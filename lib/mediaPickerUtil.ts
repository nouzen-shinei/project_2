import { logger } from '@/lib/logger';
// Media picker utility with proper error handling for expo modules
// This avoids the createPermissionHook error by checking platform compatibility


import { Platform } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';

const isWeb = Platform.OS === 'web';

/**
 * Infers MIME type from a URI file extension.
 * Strips query strings before extracting the extension.
 * Falls back to 'application/octet-stream' for unknown extensions.
 */
export function inferFileType(uri: string): string {
  const ext = (uri.split('?')[0].split('.').pop() ?? '').toLowerCase();
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    heic: 'image/heic',
    heif: 'image/heic',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    avi: 'video/x-msvideo',
    pdf: 'application/pdf',
  };
  return map[ext] ?? 'application/octet-stream';
}

// -------------------------------------------------------------------------
// Internal type definitions for the web camera mount helper
// -------------------------------------------------------------------------
interface MountCameraOptions {
  mode: 'photo' | 'video' | 'photo-video';
  webVideoMaxDurationSeconds?: number;
  aspectRatio?: number;
}

interface NormalizedPickerResult {
  canceled: boolean;
  assets: Array<{
    uri: string;
    type: 'image' | 'video';
    fileName: string;
    fileSize: number | null;
    duration: number | null;
    aspectRatio?: number;
    mimeType?: string;
  }>;
}

/**
 * Imperatively mounts the CameraCapture component into a detached DOM node,
 * awaits a capture result or cancellation, and normalises the result into
 * the same { canceled, assets } shape as expo-image-picker.
 *
 * The DOM container is appended to document.body before the await and removed
 * unconditionally (success or cancel) in the cleanup callback.
 *
 * Only called on the web platform — never imported on native.
 */
async function mountCameraCaptureOnWeb(opts: MountCameraOptions): Promise<NormalizedPickerResult> {
  // Dynamic imports keep this helper tree-shakeable and avoid static
  // references to react-dom/client on native bundles.
  const { createRoot } = await import('react-dom/client');
  const React = await import('react');
  // Import .web directly — dynamic import() does NOT apply Metro platform suffixes,
  // so importing '@/components/CameraCapture' would resolve index.tsx → .native export.
  const { CameraCapture } = await import('@/components/CameraCapture/CameraCapture.web');

  return new Promise<NormalizedPickerResult>((resolve) => {
    const container = document.createElement('div');
    // z-index 2147483647 is the maximum — ensures we sit above React Native Modal backdrops
    container.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:all;';
    document.body.appendChild(container);
    const root = createRoot(container);

    const cleanup = () => {
      try {
        root.unmount();
      } catch {
        // ignore unmount errors
      }
      try {
        if (container.parentNode) {
          document.body.removeChild(container);
        }
      } catch {
        // ignore removal errors
      }
    };

    const handleCapture = (result: import('@/types/camera').CaptureResult) => {
      cleanup();
      const fileType = result.fileType ?? inferFileType(result.uri);
      const mimePrefix = fileType.split('/')[0] as 'image' | 'video';
      const timestamp = Date.now();
      const defaultExt = mimePrefix === 'video' ? 'mp4' : 'jpg';
      resolve({
        canceled: false,
        assets: [{
          uri: result.uri,
          type: mimePrefix,
          fileName: result.fileName ?? `${mimePrefix}_${timestamp}.${defaultExt}`,
          fileSize: result.fileSize ?? null,
          duration: result.duration ?? null,
          mimeType: fileType,
          ...(opts.aspectRatio != null && { aspectRatio: opts.aspectRatio }),
        }],
      });
    };

    const handleCancel = () => {
      cleanup();
      resolve({ canceled: true, assets: [] });
    };

    root.render(
      React.default.createElement(CameraCapture, {
        mode: opts.mode,
        onCapture: handleCapture,
        onCancel: handleCancel,
        webVideoMaxDurationSeconds: opts.webVideoMaxDurationSeconds,
      })
    );
  });
}

export const MediaPickerUtil = {
  async selectImageNoEdit() {
    try {
      if (isWeb) {
        return await this.selectImageWeb(false);
      }

      // Check and request permissions
      let permissionGranted = false;
      try {
        const { status } = await ImagePicker.getMediaLibraryPermissionsAsync();
        if (status === 'granted') {
          permissionGranted = true;
        } else {
          const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
          permissionGranted = permissionResult.granted;
        }
      } catch (permError) {
        logger.warn('Permission check failed, trying direct access:', permError);
        permissionGranted = true;
      }

      if (!permissionGranted) {
        throw new Error('Permission to access photo library is required');
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: false,
        allowsMultipleSelection: false,
        quality: 0.8,
      });

      return result;
    } catch (error) {
      logger.error('Error selecting image (no edit):', error);
      if (isWeb) {
        return await this.selectImageWeb(false);
      }
      throw error;
    }
  },
  async selectImage(allowsMultipleSelection: boolean = false) {
    try {
      // On web, use native HTML file input as fallback
      if (isWeb) {
        return await this.selectImageWeb(allowsMultipleSelection);
      }

      // Use statically imported ImagePicker
      
      // Check and request permissions
      let permissionGranted = false;
      try {
        const { status } = await ImagePicker.getMediaLibraryPermissionsAsync();
        if (status === 'granted') {
          permissionGranted = true;
        } else {
          const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
          permissionGranted = permissionResult.granted;
        }
      } catch (permError) {
        logger.warn('Permission check failed, trying direct access:', permError);
        permissionGranted = true; // Fallback for web/some platforms
      }
      
      if (!permissionGranted) {
        throw new Error('Permission to access photo library is required');
      }
      
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: !allowsMultipleSelection, // Disable editing for multiple selection
        allowsMultipleSelection,
        aspect: [4, 3],
        quality: 0.8,
      });
      
      return result;
    } catch (error) {
      logger.error('Error selecting image:', error);
      // On error, try web fallback
      if (isWeb) {
        return await this.selectImageWeb(allowsMultipleSelection);
      }
      throw error;
    }
  },

  async captureImage() {
    try {
      if (isWeb) {
        return mountCameraCaptureOnWeb({ mode: 'photo' });
      }

      // Use statically imported ImagePicker
      
      // Check and request camera permissions
      let permissionGranted = false;
      try {
        const { status } = await ImagePicker.getCameraPermissionsAsync();
        if (status === 'granted') {
          permissionGranted = true;
        } else {
          const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
          permissionGranted = permissionResult.granted;
        }
      } catch (permError) {
        logger.warn('Camera permission check failed:', permError);
        throw new Error('Camera permission is required');
      }
      
      if (!permissionGranted) {
        throw new Error('Permission to access camera is required');
      }
      
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        aspect: [4, 3],
        quality: 0.8,
      });
      
      return result;
    } catch (error) {
      logger.error('Error capturing image:', error);
      throw error;
    }
  },

  async captureImageNoEdit() {
    try {
      if (isWeb) {
        return mountCameraCaptureOnWeb({ mode: 'photo-video' });
      }

      // Check and request camera permissions
      let permissionGranted = false;
      try {
        const { status } = await ImagePicker.getCameraPermissionsAsync();
        if (status === 'granted') {
          permissionGranted = true;
        } else {
          const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
          permissionGranted = permissionResult.granted;
        }
      } catch (permError) {
        logger.warn('Camera permission check failed:', permError);
        throw new Error('Camera permission is required');
      }

      if (!permissionGranted) {
        throw new Error('Permission to access camera is required');
      }

      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: false,
        quality: 0.8,
      });

      return result;
    } catch (error) {
      logger.error('Error capturing image (no edit):', error);
      throw error;
    }
  },

  async selectDocument(type: string = '*/*', allowsMultipleSelection: boolean = false) {
    try {
      // On web, use native HTML file input
      if (isWeb) {
        return await this.selectDocumentWeb(type, allowsMultipleSelection);
      }

      // Use statically imported DocumentPicker
      
      const result = await DocumentPicker.getDocumentAsync({
        type,
        copyToCacheDirectory: true,
        multiple: allowsMultipleSelection,
      });
      
      return result;
    } catch (error) {
      logger.error('Error selecting document:', error);
      // On error, try web fallback
      if (isWeb) {
        return await this.selectDocumentWeb(type, allowsMultipleSelection);
      }
      throw error;
    }
  },

  async selectVideo(allowsMultipleSelection: boolean = false) {
    try {
      // On web, use native HTML file input as fallback
      if (isWeb) {
        return await this.selectVideoWeb(allowsMultipleSelection);
      }

      // Use statically imported ImagePicker
      
      // Check and request permissions
      let permissionGranted = false;
      try {
        const { status } = await ImagePicker.getMediaLibraryPermissionsAsync();
        if (status === 'granted') {
          permissionGranted = true;
        } else {
          const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
          permissionGranted = permissionResult.granted;
        }
      } catch (permError) {
        logger.warn('Permission check failed, trying direct access:', permError);
        permissionGranted = true; // Fallback for web/some platforms
      }
      
      if (!permissionGranted) {
        throw new Error('Permission to access photo library is required');
      }
      
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        allowsEditing: !allowsMultipleSelection,
        allowsMultipleSelection,
        quality: 0.8,
        videoMaxDuration: 300,
        // videoExportPreset forces H.264 on iOS. Requires allowsEditing (single-select only).
        // Prevents HEVC uploads that won't play in Android/web browsers.
        ...(allowsMultipleSelection
          ? {
              preferredAssetRepresentationMode:
                ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
            }
          : {
              videoExportPreset: ImagePicker.VideoExportPreset.H264_1920x1080,
              preferredAssetRepresentationMode:
                ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
            }),
      });
      
      return result;
    } catch (error) {
      logger.error('Error selecting video:', error);
      // On error, try web fallback
      if (isWeb) {
        return await this.selectVideoWeb(allowsMultipleSelection);
      }
      throw error;
    }
  },

  async captureVideo() {
    try {
      // On web, camera capture is not available
      if (isWeb) {
        return mountCameraCaptureOnWeb({ mode: 'photo-video', webVideoMaxDurationSeconds: 60 });
      }

      // Use statically imported ImagePicker
      
      // Check and request camera permissions
      let permissionGranted = false;
      try {
        const { status } = await ImagePicker.getCameraPermissionsAsync();
        if (status === 'granted') {
          permissionGranted = true;
        } else {
          const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
          permissionGranted = permissionResult.granted;
        }
      } catch (permError) {
        logger.warn('Camera permission check failed:', permError);
        throw new Error('Camera permission is required');
      }
      
      if (!permissionGranted) {
        throw new Error('Permission to access camera is required');
      }
      
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Videos,
        allowsEditing: true,
        quality: 0.8,
        videoMaxDuration: 300, // 5 minutes max
        // Force H.264 recording so the video plays in every browser/platform.
        // iOS encodes directly to H.264 via its hardware encoder (no server cost).
        videoExportPreset: ImagePicker.VideoExportPreset.H264_1920x1080,
      });
      
      return result;
    } catch (error) {
      logger.error('Error capturing video:', error);
      throw error;
    }
  },

  // Web-specific implementations
  async selectImageWeb(allowsMultipleSelection: boolean = false) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = allowsMultipleSelection;
      
      input.onchange = (event: any) => {
        const files = Array.from(event.target.files || []) as File[];
        if (files.length > 0) {
          const assets = files.map((file) => {
            const objectUrl = URL.createObjectURL(file);
            return {
              uri: objectUrl,
              previewUri: objectUrl,
              width: 0,
              height: 0,
              type: 'image',
              mimeType: file.type,
              fileSize: file.size,
              fileName: file.name,
              file,
              webFile: file,
            };
          });

          resolve({
            canceled: false,
            assets: allowsMultipleSelection ? assets : assets.slice(0, 1),
          });
        } else {
          resolve({ canceled: true, assets: [] });
        }
      };
      
      input.oncancel = () => {
        resolve({ canceled: true, assets: [] });
      };
      
      input.click();
    });
  },

  async selectDocumentWeb(type: string = '*/*', allowsMultipleSelection: boolean = false) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = type;
      input.multiple = allowsMultipleSelection;
      
      input.onchange = (event: any) => {
        const files = Array.from(event.target.files || []) as File[];
        if (files.length > 0) {
          if (allowsMultipleSelection) {
            // Handle multiple files
            const results = files.map(file => ({
              type: 'success',
              name: file.name,
              size: file.size,
              uri: URL.createObjectURL(file),
              mimeType: file.type,
              file,
              webFile: file,
            }));
            resolve({ type: 'success', files: results });
          } else {
            // Handle single file
            const file = files[0];
            resolve({
              type: 'success',
              name: file.name,
              size: file.size,
              uri: URL.createObjectURL(file),
              mimeType: file.type,
              file,
              webFile: file,
            });
          }
        } else {
          resolve({ type: 'cancel' });
        }
      };
      
      input.oncancel = () => {
        resolve({ type: 'cancel' });
      };
      
      input.click();
    });
  },

  async selectVideoWeb(allowsMultipleSelection: boolean = false) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'video/*';
      input.multiple = allowsMultipleSelection;
      
      input.onchange = (event: any) => {
        const files = Array.from(event.target.files || []) as File[];
        if (files.length > 0) {
          const assets = files.map((file) => {
            const objectUrl = URL.createObjectURL(file);
            return {
              uri: objectUrl,
              previewUri: objectUrl,
              width: 0,
              height: 0,
              type: 'video',
              mimeType: file.type,
              fileSize: file.size,
              fileName: file.name,
              duration: 0,
              file,
              webFile: file,
            };
          });

          resolve({
            canceled: false,
            assets: allowsMultipleSelection ? assets : assets.slice(0, 1),
          });
        } else {
          resolve({ canceled: true, assets: [] });
        }
      };
      
      input.oncancel = () => {
        resolve({ canceled: true, assets: [] });
      };
      
      input.click();
    });
  },

  async selectProfileImage() {
    try {
      // On web, use native HTML file input as fallback
      if (isWeb) {
        return await this.selectImageWeb();
      }

      // Use statically imported ImagePicker
      
      // Check and request permissions with better error handling
      let permissionGranted = false;
      try {
        const { status } = await ImagePicker.getMediaLibraryPermissionsAsync();
        if (status === 'granted') {
          permissionGranted = true;
        } else {
          const permissionResult = await ImagePicker.requestMediaLibraryPermissionsAsync();
          permissionGranted = permissionResult.granted;
        }
      } catch (permError) {
        logger.warn('Permission check failed, trying direct access:', permError);
        permissionGranted = true; // Fallback for web/some platforms
      }
      
      if (!permissionGranted) {
        throw new Error('Permission to access photo library is required');
      }
      
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      
      return result;
    } catch (error) {
      logger.error('Error selecting profile image:', error);
      // On error, try web fallback
      if (isWeb) {
        return await this.selectImageWeb();
      }
      throw error;
    }
  },

  async captureProfileImage() {
    try {
      // On web, camera capture is not available, so redirect to select
      if (isWeb) {
        return mountCameraCaptureOnWeb({ mode: 'photo', aspectRatio: 1 });
      }

      // Use statically imported ImagePicker
      
      // Check and request camera permissions with better error handling
      let permissionGranted = false;
      try {
        const { status } = await ImagePicker.getCameraPermissionsAsync();
        if (status === 'granted') {
          permissionGranted = true;
        } else {
          const permissionResult = await ImagePicker.requestCameraPermissionsAsync();
          permissionGranted = permissionResult.granted;
        }
      } catch (permError) {
        logger.warn('Camera permission check failed:', permError);
        throw new Error('Camera permission is required');
      }
      
      if (!permissionGranted) {
        throw new Error('Permission to access camera is required');
      }
      
      const result = await ImagePicker.launchCameraAsync({
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      
      return result;
    } catch (error) {
      logger.error('Error capturing profile image:', error);
      throw error;
    }
  },

  async selectAudioFiles(allowsMultipleSelection: boolean = false) {
    try {
      if (isWeb) {
        return await this.selectAudioWeb(allowsMultipleSelection);
      }

      // Use statically imported DocumentPicker
      
      const result = await DocumentPicker.getDocumentAsync({
        type: ['audio/*'],
        copyToCacheDirectory: true,
        multiple: allowsMultipleSelection,
      });
      
      return result;
    } catch (error) {
      logger.error('Error selecting audio files:', error);
      throw error;
    }
  },

  async selectCodeFiles(allowsMultipleSelection: boolean = false) {
    try {
      if (isWeb) {
        return await this.selectCodeWeb(allowsMultipleSelection);
      }

      // Use statically imported DocumentPicker
      
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/*', 'application/json', 'application/javascript', 'application/typescript'],
        copyToCacheDirectory: true,
        multiple: allowsMultipleSelection,
      });
      
      return result;
    } catch (error) {
      logger.error('Error selecting code files:', error);
      throw error;
    }
  },

  async selectPdfFiles(allowsMultipleSelection: boolean = false) {
    try {
      if (isWeb) {
        return await this.selectPdfWeb(allowsMultipleSelection);
      }

      // Use statically imported DocumentPicker
      
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/pdf',
        copyToCacheDirectory: true,
        multiple: allowsMultipleSelection,
      });
      
      return result;
    } catch (error) {
      logger.error('Error selecting PDF files:', error);
      throw error;
    }
  },

  async selectPresentationFiles(allowsMultipleSelection: boolean = false) {
    try {
      if (isWeb) {
        return await this.selectPresentationWeb(allowsMultipleSelection);
      }

      // Use statically imported DocumentPicker
      
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'application/vnd.ms-powerpoint',
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'application/vnd.oasis.opendocument.presentation'
        ],
        copyToCacheDirectory: true,
        multiple: allowsMultipleSelection,
      });
      
      return result;
    } catch (error) {
      logger.error('Error selecting presentation files:', error);
      throw error;
    }
  },

  async selectSpreadsheetFiles(allowsMultipleSelection: boolean = false) {
    try {
      if (isWeb) {
        return await this.selectSpreadsheetWeb(allowsMultipleSelection);
      }

      // Use statically imported DocumentPicker
      
      const result = await DocumentPicker.getDocumentAsync({
        type: [
          'application/vnd.ms-excel',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.oasis.opendocument.spreadsheet',
          'text/csv'
        ],
        copyToCacheDirectory: true,
        multiple: allowsMultipleSelection,
      });
      
      return result;
    } catch (error) {
      logger.error('Error selecting spreadsheet files:', error);
      throw error;
    }
  },

  async selectMixedFiles(allowsMultipleSelection: boolean = true) {
    try {
      if (isWeb) {
        return await this.selectMixedWeb(allowsMultipleSelection);
      }

      // Use statically imported DocumentPicker
      
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*', // Allow all file types
        copyToCacheDirectory: true,
        multiple: allowsMultipleSelection,
      });
      
      return result;
    } catch (error) {
      logger.error('Error selecting mixed files:', error);
      throw error;
    }
  },

  // Web fallback methods for new file types
  async selectAudioWeb(allowsMultipleSelection: boolean = false) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'audio/*';
      input.multiple = allowsMultipleSelection;
      
      input.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        const files = target.files;
        if (files && files.length > 0) {
          const file = files[0];
          resolve({
            assets: [{
              name: file.name,
              uri: URL.createObjectURL(file),
              size: file.size,
              mimeType: file.type,
            }],
            canceled: false,
          });
        } else {
          resolve({ canceled: true });
        }
      };
      
      input.click();
    });
  },

  async selectCodeWeb(allowsMultipleSelection: boolean = false) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.js,.ts,.jsx,.tsx,.py,.java,.cpp,.c,.html,.css,.json,.xml,.md,.yml,.yaml,.php,.rb,.go,.rs,.swift,.kt,.txt';
      input.multiple = allowsMultipleSelection;
      
      input.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        const files = target.files;
        if (files && files.length > 0) {
          const file = files[0];
          resolve({
            assets: [{
              name: file.name,
              uri: URL.createObjectURL(file),
              size: file.size,
              mimeType: file.type,
            }],
            canceled: false,
          });
        } else {
          resolve({ canceled: true });
        }
      };
      
      input.click();
    });
  },

  async selectPdfWeb(allowsMultipleSelection: boolean = false) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.pdf';
      input.multiple = allowsMultipleSelection;
      
      input.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        const files = target.files;
        if (files && files.length > 0) {
          const file = files[0];
          resolve({
            assets: [{
              name: file.name,
              uri: URL.createObjectURL(file),
              size: file.size,
              mimeType: file.type,
            }],
            canceled: false,
          });
        } else {
          resolve({ canceled: true });
        }
      };
      
      input.click();
    });
  },

  async selectPresentationWeb(allowsMultipleSelection: boolean = false) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.ppt,.pptx,.odp,.key';
      input.multiple = allowsMultipleSelection;
      
      input.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        const files = target.files;
        if (files && files.length > 0) {
          const file = files[0];
          resolve({
            assets: [{
              name: file.name,
              uri: URL.createObjectURL(file),
              size: file.size,
              mimeType: file.type,
            }],
            canceled: false,
          });
        } else {
          resolve({ canceled: true });
        }
      };
      
      input.click();
    });
  },

  async selectSpreadsheetWeb(allowsMultipleSelection: boolean = false) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.xls,.xlsx,.ods,.csv,.numbers';
      input.multiple = allowsMultipleSelection;
      
      input.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        const files = target.files;
        if (files && files.length > 0) {
          const file = files[0];
          resolve({
            assets: [{
              name: file.name,
              uri: URL.createObjectURL(file),
              size: file.size,
              mimeType: file.type,
            }],
            canceled: false,
          });
        } else {
          resolve({ canceled: true });
        }
      };
      
      input.click();
    });
  },

  async selectMixedWeb(allowsMultipleSelection: boolean = true) {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '*/*';
      input.multiple = allowsMultipleSelection;
      
      input.onchange = (e) => {
        const target = e.target as HTMLInputElement;
        const files = target.files;
        if (files && files.length > 0) {
          const file = files[0];
          resolve({
            assets: [{
              name: file.name,
              uri: URL.createObjectURL(file),
              size: file.size,
              mimeType: file.type,
            }],
            canceled: false,
          });
        } else {
          resolve({ canceled: true });
        }
      };
      
      input.click();
    });
  },
};
