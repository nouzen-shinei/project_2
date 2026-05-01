import { type UploadProgressDisplayEasingOptions } from '@/lib/uploadProgressDisplayEasing';

export const DOWNLOAD_PROGRESS_EASING_PRESET: UploadProgressDisplayEasingOptions = {
  smoothingPerSecond: 10,
  minStepPercent: 0.15,
  completionSnapThresholdPercent: 99.2,
  nearCompletionBoostStartPercent: 96,
  nearCompletionBoostMultiplier: 1.3,
};
