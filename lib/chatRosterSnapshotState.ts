export interface ChatRosterSnapshotMember {
  id?: string | number | null;
  email?: string | null;
}

function normalizeChatRosterSnapshotEmail(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase();
}

export function resolveChatRosterSnapshotForRoster<T extends ChatRosterSnapshotMember>(
  roster: T[],
  rawSnapshot: Map<string, T>
): Map<string, T> {
  if (!Array.isArray(roster) || roster.length === 0) {
    return new Map();
  }

  const rosterEmails = new Set(
    roster
      .map((member) => normalizeChatRosterSnapshotEmail(member?.email))
      .filter((value): value is string => Boolean(value))
  );

  if (rosterEmails.size === 0) {
    return new Map();
  }

  const filtered = new Map<string, T>();
  rawSnapshot.forEach((member, key) => {
    if (rosterEmails.has(key)) {
      filtered.set(key, member);
    }
  });

  return filtered;
}
