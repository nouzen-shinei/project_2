import { useEasedUploadProgress } from '@/hooks/useEasedUploadProgress';
import { DOWNLOAD_PROGRESS_EASING_PRESET } from '@/lib/transferProgressEasingPresets';
import { normalizeUploadProgressDisplayPercent } from '@/lib/uploadProgressDisplayEasing';

export function useEasedDownloadProgressPercent(
  progress: number | null | undefined,
  isActive: boolean
): number {
  const easedDownloadProgress = useEasedUploadProgress(progress ?? 0, {
    isActive,
    ...DOWNLOAD_PROGRESS_EASING_PRESET,
  });

  return normalizeUploadProgressDisplayPercent(easedDownloadProgress);
}
