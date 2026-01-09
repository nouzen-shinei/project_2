let lastInAppRoute: string | null = null;

export function setLastInAppRoute(path: string): void {
  const normalized = (path || '').trim();
  if (!normalized) return;
  // Only store absolute expo-router paths.
  if (!normalized.startsWith('/')) return;
  // Avoid storing the plan page itself.
  if (normalized === '/(tabs)/plan') return;
  // Avoid storing billing history; the Plan screen should never "close back" into it.
  if (normalized === '/(tabs)/billing-history') return;
  lastInAppRoute = normalized;
}

export function getLastInAppRoute(): string | null {
  return lastInAppRoute;
}
