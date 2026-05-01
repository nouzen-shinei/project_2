/**
 * Composer layout helpers
 * 
 * Pure deterministic logic for calculating composer dimensions and visibility padding.
 */

/**
 * Default base height of composer input field (pixels).
 */
export const COMPOSER_BASE_HEIGHT = 40;

/**
 * Calculates the effective composer height clamped to minimum base height.
 * 
 * If inputHeight is undefined/null, returns base height.
 * Otherwise returns the maximum of inputHeight and base height.
 */
export function resolveChatComposerEffectiveHeight(
  inputHeight?: number | null
): number {
  const height = inputHeight || COMPOSER_BASE_HEIGHT;
  return Math.max(height, COMPOSER_BASE_HEIGHT);
}

/**
 * Calculates the extra height beyond the base composer height.
 * 
 * Returns the difference between effective height and base height,
 * or 0 if the effective height is less than base.
 */
export function resolveChatComposerExtraHeight(
  effectiveHeight: number
): number {
  return Math.max(0, effectiveHeight - COMPOSER_BASE_HEIGHT);
}

/**
 * Calculates the adaptive extra height to apply for visibility padding.
 * 
 * Limits the extra height to a maximum of 28 pixels to avoid excessive padding.
 * This prevents very tall composer heights from creating too much buffer space.
 */
export function resolveChatComposerAdaptiveExtraHeight(
  extraHeight: number
): number {
  return Math.min(extraHeight, 28);
}

/**
 * Calculates total bottom visibility padding for chat message list.
 * 
 * The padding ensures messages remain visible above the composer,
 * accounting for base buffer + composer height expansion + autoscroll offset.
 * 
 * Total = baseBuffer + adaptiveExtra
 */
export function resolveChatBottomVisibilityPadding(
  baseBuffer: number,
  inputHeight?: number | null
): number {
  const effectiveHeight = resolveChatComposerEffectiveHeight(inputHeight);
  const extraHeight = resolveChatComposerExtraHeight(effectiveHeight);
  const adaptiveExtra = resolveChatComposerAdaptiveExtraHeight(extraHeight);
  
  const basePadding = baseBuffer + 12; // 12px small buffer to float above composer
  return basePadding + adaptiveExtra;
}

/**
 * Calculates the autoscroll threshold for maintaining visible content position.
 * 
 * This is used by React Native's maintainVisibleContentPosition to determine
 * when to autoscroll. Adds 48px buffer to the visibility padding.
 */
export function resolveChatAutoscrollToTopThreshold(
  bottomVisibilityPadding: number
): number {
  return bottomVisibilityPadding + 48;
}

/**
 * Validates if a composer height value is reasonable.
 * 
 * Returns true if height is a finite positive number or undefined.
 * Used to detect invalid/corrupted height values.
 */
export function isChatComposerHeightValid(
  inputHeight?: number | null
): boolean {
  if (inputHeight === undefined || inputHeight === null) {
    return true; // undefined/null is valid (will use base height)
  }
  
  return typeof inputHeight === 'number' && Number.isFinite(inputHeight) && inputHeight > 0;
}
