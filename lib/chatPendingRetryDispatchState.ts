import type { ChatPendingRetryTarget } from './chatPendingRetryBatchState';

export interface ChatPendingRetryDispatchHandlers {
  text: (tempId: string) => Promise<boolean>;
  media: (tempId: string) => Promise<boolean>;
  attachment: (tempId: string) => Promise<boolean>;
}

export interface ChatPendingRetryDispatchInput {
  orderedTargets: readonly ChatPendingRetryTarget[];
  handlers: ChatPendingRetryDispatchHandlers;
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function resolveChatPendingRetryDispatchPromises(
  input: ChatPendingRetryDispatchInput
): Promise<boolean>[] {
  if (!Array.isArray(input.orderedTargets) || input.orderedTargets.length === 0) {
    return [];
  }

  const promises: Promise<boolean>[] = [];

  input.orderedTargets.forEach((target) => {
    if (!target || !isNonEmptyId(target.tempId)) {
      return;
    }

    const normalizedId = target.tempId.trim();
    if (target.kind === 'text') {
      promises.push(input.handlers.text(normalizedId));
      return;
    }

    if (target.kind === 'media') {
      promises.push(input.handlers.media(normalizedId));
      return;
    }

    promises.push(input.handlers.attachment(normalizedId));
  });

  return promises;
}
