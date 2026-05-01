export interface ChatComposerDraftIdentity {
  id?: string | number | null;
  email?: string | null;
}

export function getChatComposerDraftKey(identity: ChatComposerDraftIdentity | null | undefined): string | null {
  if (!identity) {
    return null;
  }

  const idPart = identity.id != null ? String(identity.id).trim() : '';
  const emailPart = typeof identity.email === 'string' ? identity.email.trim().toLowerCase() : '';

  if (!idPart && !emailPart) {
    return null;
  }

  return `${idPart}|${emailPart}`;
}
