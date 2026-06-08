/**
 * CameraCapture platform router.
 *
 * This file is the fallback export. Metro (native) resolves
 * CameraCapture.native.tsx for iOS/Android builds, and webpack resolves
 * CameraCapture.web.tsx for browser builds — both automatically via the
 * `moduleSuffixes` setting in tsconfig.json (".native", ".web", "").
 *
 * Importing from '@/components/CameraCapture' will therefore resolve to the
 * correct platform implementation without any runtime Platform.OS checks.
 */
export { CameraCapture } from './CameraCapture.native';
