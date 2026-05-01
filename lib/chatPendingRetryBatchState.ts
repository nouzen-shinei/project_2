export type ChatPendingRetryTargetKind = 'text' | 'media' | 'attachment';

export interface ChatPendingRetryTarget {
  kind: ChatPendingRetryTargetKind;
  tempId: string;
}

export interface ChatPendingRetryBatchPlanInput {
  retryableTextIds: readonly string[];
  retryableMediaIds: readonly string[];
  retryableAttachmentIds: readonly string[];
}

export interface ChatPendingRetryBatchPlan {
  totalCount: number;
  orderedTargets: ChatPendingRetryTarget[];
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function pushTargets(
  output: ChatPendingRetryTarget[],
  ids: readonly string[],
  kind: ChatPendingRetryTargetKind
): void {
  ids.forEach((tempId) => {
    if (!isNonEmptyId(tempId)) {
      return;
    }

    output.push({ kind, tempId: tempId.trim() });
  });
}

export function resolveChatPendingRetryBatchPlan(
  input: ChatPendingRetryBatchPlanInput
): ChatPendingRetryBatchPlan {
  const orderedTargets: ChatPendingRetryTarget[] = [];

  pushTargets(orderedTargets, input.retryableTextIds, 'text');
  pushTargets(orderedTargets, input.retryableMediaIds, 'media');
  pushTargets(orderedTargets, input.retryableAttachmentIds, 'attachment');

  return {
    totalCount: orderedTargets.length,
    orderedTargets,
  };
}
