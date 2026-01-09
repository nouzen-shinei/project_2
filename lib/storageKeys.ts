export const STORAGE_KEYS = {
  cachedUserData: '@cached_user_data',
  cachedAuthorizedEmails: '@cached_authorizedEmails',
  userProfile: 'userProfile',
  appSettings: 'appSettings',
  authorizedEmails: 'authorizedEmails',
  customProfilePicture: 'customProfilePicture',
  useCustomProfilePicture: 'useCustomProfilePicture',
  cacheLastClearedAt: '@tm_cache_last_cleared_at',
  selectedTenantId: '@tm_selected_tenant_id',
  cachedTenantMemberships: '@tm_cached_tenant_memberships',
  tenantNotificationPreferenceDrafts: '@tm_notification_pref_drafts',
} as const;

export const PROTECTED_CACHE_KEYS = new Set<string>([
  STORAGE_KEYS.cachedUserData,
  STORAGE_KEYS.cachedAuthorizedEmails,
  STORAGE_KEYS.userProfile,
  STORAGE_KEYS.appSettings,
  STORAGE_KEYS.authorizedEmails,
  STORAGE_KEYS.customProfilePicture,
  STORAGE_KEYS.useCustomProfilePicture,
  STORAGE_KEYS.cacheLastClearedAt,
  STORAGE_KEYS.selectedTenantId,
  STORAGE_KEYS.cachedTenantMemberships,
  STORAGE_KEYS.tenantNotificationPreferenceDrafts,
]);
