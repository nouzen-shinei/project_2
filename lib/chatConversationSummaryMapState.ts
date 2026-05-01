export interface ChatConversationSummaryLastMessageSnapshot {
  messageId?: string;
  delivered?: boolean;
  read?: boolean;
  text?: string;
}

export interface ChatConversationSummarySnapshot {
  partnerEmail: string;
  tenantId?: string | null;
  unreadCount: number;
  updatedAt: string;
  lastMessage?: ChatConversationSummaryLastMessageSnapshot;
}

export function upsertChatConversationSummary<
  T extends ChatConversationSummarySnapshot
>(
  current: Map<string, T>,
  incomingSummary: T,
  fallbackTenantId?: string | null
): Map<string, T> {
  const partnerEmail =
    typeof incomingSummary.partnerEmail === 'string'
      ? incomingSummary.partnerEmail.toLowerCase()
      : '';

  if (!partnerEmail) {
    return current;
  }

  const existing = current.get(partnerEmail);
  const existingLast = existing?.lastMessage;
  const nextLast = incomingSummary.lastMessage;
  const unchanged = Boolean(
    existing &&
      existing.unreadCount === incomingSummary.unreadCount &&
      existing.updatedAt === incomingSummary.updatedAt &&
      existingLast?.messageId === nextLast?.messageId &&
      existingLast?.delivered === nextLast?.delivered &&
      existingLast?.read === nextLast?.read &&
      existingLast?.text === nextLast?.text
  );

  if (unchanged) {
    return current;
  }

  const next = new Map(current);
  next.set(partnerEmail, {
    ...(existing ?? {
      partnerEmail,
      tenantId: fallbackTenantId ?? null,
      unreadCount: 0,
      updatedAt: incomingSummary.updatedAt,
    }),
    ...incomingSummary,
    partnerEmail,
    tenantId:
      incomingSummary.tenantId ?? existing?.tenantId ?? fallbackTenantId ?? null,
  } as T);

  return next;
}
