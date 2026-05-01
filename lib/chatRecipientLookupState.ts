export interface ChatRecipientLookupMemberLike {
  id?: unknown;
  email?: unknown;
}

export interface ResolveChatTeamMembersByRecipientKeyParams<TMember extends ChatRecipientLookupMemberLike> {
  teamMembersWithChatInfo: readonly TMember[];
  teamMembers: readonly TMember[];
  normalizeParticipantEmail: (value: unknown) => string;
}

export function resolveChatTeamMembersByRecipientKey<TMember extends ChatRecipientLookupMemberLike>(
  params: ResolveChatTeamMembersByRecipientKeyParams<TMember>
): Map<string, TMember> {
  const {
    teamMembersWithChatInfo,
    teamMembers,
    normalizeParticipantEmail,
  } = params;

  const map = new Map<string, TMember>();

  teamMembersWithChatInfo.forEach((member) => {
    const normalizedId = normalizeParticipantEmail(member?.id);
    const normalizedEmail = normalizeParticipantEmail(member?.email);

    if (normalizedId && !map.has(normalizedId)) {
      map.set(normalizedId, member);
    }

    if (normalizedEmail && !map.has(normalizedEmail)) {
      map.set(normalizedEmail, member);
    }
  });

  teamMembers.forEach((member) => {
    const normalizedId = normalizeParticipantEmail(member?.id);
    const normalizedEmail = normalizeParticipantEmail(member?.email);

    if (normalizedId && !map.has(normalizedId)) {
      map.set(normalizedId, member);
    }

    if (normalizedEmail && !map.has(normalizedEmail)) {
      map.set(normalizedEmail, member);
    }
  });

  return map;
}

export function resolveChatPendingRecipientEmail<TMember extends ChatRecipientLookupMemberLike>(params: {
  recipientId?: string;
  teamMembersByRecipientKey: Map<string, TMember>;
  normalizeParticipantEmail: (value: unknown) => string;
}): string {
  const { recipientId, teamMembersByRecipientKey, normalizeParticipantEmail } = params;
  const normalizedRecipientId = normalizeParticipantEmail(recipientId);

  if (!normalizedRecipientId) {
    return '';
  }

  const resolvedMember = teamMembersByRecipientKey.get(normalizedRecipientId);
  if (typeof resolvedMember?.email === 'string' && resolvedMember.email) {
    return resolvedMember.email;
  }

  return recipientId || '';
}
