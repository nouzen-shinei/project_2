// Feature: device-console-migration (Task 17.1 / 17.3)
//
// Pure predicate for the retired client-side admin device-management surface.
//
// The Device Console migration removed the client "Notifications" admin tab (which
// was in reality a full device-management console). A stored deep link / persisted
// route / query that still points at that removed surface must be recognised so the
// admin screen can render an "interface unavailable" view instead of resurrecting the
// removed UI or crashing (Requirement 18.1 — no navigation entry point remains;
// Requirement 18.5 — retired deep links render the unavailable view).
//
// This logic is extracted from `app/(tabs)/admin.tsx` into a route-free `lib/` module
// so it can be exercised directly by unit tests without loading the heavy Admin screen
// (and its many React Native / Expo / provider dependencies). `app/(tabs)/admin.tsx`
// imports and uses `isRetiredAdminRouteTarget` verbatim, so this is the exact predicate
// that drives the screen's behaviour — no behaviour change.

// Values in a stored deep link / saved route that point at the retired client-side
// device-management admin surface (formerly the "Notifications" tab). Any request whose
// `tab` or `view` param normalises to one of these targets the removed UI.
export const RETIRED_ADMIN_ROUTE_TARGETS = new Set<string>([
  'notifications',
  'notification',
  'devices',
  'device',
  'device-management',
  'devicemanagement',
]);

/**
 * Normalises a route param value (which expo-router may surface as a string or an
 * array of strings) to a trimmed, lower-cased string for comparison.
 */
const normalizeRouteValue = (value?: string | string[]): string => {
  const raw = Array.isArray(value) ? value[0] : value;
  return (raw || '').trim().toLowerCase();
};

/**
 * Returns true when the provided route params (`tab` and/or `view`) point at the
 * retired client-side device-management admin surface, using case-insensitive,
 * whitespace-trimmed, array-safe matching.
 */
export const isRetiredAdminRouteTarget = (params: {
  tab?: string | string[];
  view?: string | string[];
}): boolean =>
  RETIRED_ADMIN_ROUTE_TARGETS.has(normalizeRouteValue(params.tab)) ||
  RETIRED_ADMIN_ROUTE_TARGETS.has(normalizeRouteValue(params.view));
