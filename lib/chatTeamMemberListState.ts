export interface ChatTeamMemberListLastMessage {
  timestamp?: string;
}

export interface ChatTeamMemberListMember {
  id?: string;
  email?: string;
  name?: string;
  unreadCount?: number;
  summaryUpdatedAt?: string;
  lastMessage?: ChatTeamMemberListLastMessage | null;
  pinnedSerial?: number;
  [key: string]: unknown;
}

export interface ChatTeamMemberListInput {
  members: ChatTeamMemberListMember[];
  pinnedChats: Record<string, number>;
  currentUserEmail?: string | null;
  searchQuery?: string;
  sanitizeEmailKey: (value: string) => string;
}

function normalizeEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function resolveRecencyTs(member: ChatTeamMemberListMember): number {
  const summaryTime = member.summaryUpdatedAt
    ? new Date(member.summaryUpdatedAt).getTime()
    : 0;
  const messageTime = member.lastMessage?.timestamp
    ? new Date(member.lastMessage.timestamp).getTime()
    : 0;
  return Math.max(summaryTime, messageTime);
}

export function resolveChatFilteredTeamMembers<
  T extends ChatTeamMemberListMember
>(
  input: Omit<ChatTeamMemberListInput, 'members'> & { members: T[] }
): T[] {
  const members = Array.isArray(input.members) ? input.members : [];
  const query = typeof input.searchQuery === 'string'
    ? input.searchQuery.toLowerCase().trim()
    : '';
  const normalizedCurrentUserEmail = normalizeEmail(input.currentUserEmail);

  const withPin = members.map((member) => ({
    ...member,
    pinnedSerial:
      input.pinnedChats[
        input.sanitizeEmailKey(
          typeof member?.email === 'string' ? member.email : ''
        )
      ] || undefined,
  })) as T[];

  return withPin
    .filter((member) => {
      if (!normalizedCurrentUserEmail) {
        return true;
      }

      const memberEmail = normalizeEmail(member.email);
      const memberId = normalizeEmail(member.id);
      return (
        memberEmail !== normalizedCurrentUserEmail &&
        memberId !== normalizedCurrentUserEmail
      );
    })
    .filter((member) => {
      if (!query) {
        return true;
      }

      const name =
        typeof member.name === 'string' ? member.name.toLowerCase() : '';
      const email =
        typeof member.email === 'string' ? member.email.toLowerCase() : '';
      return name.includes(query) || email.includes(query);
    })
    .sort((a, b) => {
      const aPin = a.pinnedSerial ?? 0;
      const bPin = b.pinnedSerial ?? 0;
      if (aPin && bPin && aPin !== bPin) {
        return aPin - bPin;
      }
      if (aPin && !bPin) {
        return -1;
      }
      if (!aPin && bPin) {
        return 1;
      }

      const aTime = resolveRecencyTs(a);
      const bTime = resolveRecencyTs(b);
      if (aTime !== bTime) {
        return bTime - aTime;
      }

      const aUnread = a.unreadCount || 0;
      const bUnread = b.unreadCount || 0;
      if (aUnread !== bUnread) {
        return bUnread - aUnread;
      }

      return String(a.name || '').localeCompare(String(b.name || ''));
    });
}
