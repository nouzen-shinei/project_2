export function resolveChatConversationSearchContextKey(params: {
  activeComposerDraftKey: string | null | undefined;
  tenantId: string | null | undefined;
}): string | null {
  const { activeComposerDraftKey, tenantId } = params;

  if (!activeComposerDraftKey) {
    return null;
  }

  const tenantIdPart =
    typeof tenantId === 'string' && tenantId.trim().length > 0
      ? tenantId.trim().toLowerCase()
      : 'default';

  return `${tenantIdPart}::${activeComposerDraftKey}`;
}
