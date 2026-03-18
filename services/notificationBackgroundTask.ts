import { logger } from '@/lib/logger';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import {
  confirmInboundChatDeliveryFromNotificationData,
  flushPendingInboundChatDeliveryReceipts,
} from './chatReceiptSync';

const BACKGROUND_NOTIFICATION_TASK = 'tm-background-chat-delivery-receipts';
const BACKGROUND_NOTIFICATION_RESULT = {
  NoData: 1,
  NewData: 2,
  Failed: 3,
} as const;

function extractNotificationDataFromTaskPayload(
  payload: Notifications.NotificationTaskPayload | null | undefined
): Record<string, any> | undefined {
  const raw = payload as any;
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const responseData = raw.notification?.request?.content?.data;
  if (responseData && typeof responseData === 'object') {
    return responseData as Record<string, any>;
  }

  if (typeof raw.data?.dataString === 'string' && raw.data.dataString.trim()) {
    try {
      const parsed = JSON.parse(raw.data.dataString);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, any>;
      }
    } catch (error) {
      logger.debug('Failed to parse background notification dataString payload', { error });
    }
  }

  if (raw.data && typeof raw.data === 'object') {
    return raw.data as Record<string, any>;
  }

  return undefined;
}

if (!TaskManager.isTaskDefined(BACKGROUND_NOTIFICATION_TASK)) {
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(BACKGROUND_NOTIFICATION_TASK, async ({ data, error }) => {
    if (error) {
      logger.warn('Background notification task failed before execution', { error });
      return BACKGROUND_NOTIFICATION_RESULT.Failed;
    }

    try {
      const notificationData = extractNotificationDataFromTaskPayload(data);
      const synced = await confirmInboundChatDeliveryFromNotificationData(notificationData, 'background-task');
      await flushPendingInboundChatDeliveryReceipts({ maxBatchSize: 15 });
      return synced
        ? BACKGROUND_NOTIFICATION_RESULT.NewData
        : BACKGROUND_NOTIFICATION_RESULT.NoData;
    } catch (taskError) {
      logger.warn('Background notification task execution failed', { taskError });
      return BACKGROUND_NOTIFICATION_RESULT.Failed;
    }
  });
}

let backgroundNotificationTaskRegistrationPromise: Promise<void> | null = null;

export async function registerBackgroundNotificationTask(): Promise<void> {
  if (Platform.OS === 'web') {
    return;
  }

  if (!backgroundNotificationTaskRegistrationPromise) {
    backgroundNotificationTaskRegistrationPromise = (async () => {
      const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_NOTIFICATION_TASK);
      if (alreadyRegistered) {
        return;
      }

      await Notifications.registerTaskAsync(BACKGROUND_NOTIFICATION_TASK);
      logger.debug('Registered background notification task', {
        taskName: BACKGROUND_NOTIFICATION_TASK,
      });
    })().catch((error) => {
      backgroundNotificationTaskRegistrationPromise = null;
      logger.warn('Failed to register background notification task', { error });
      throw error;
    });
  }

  await backgroundNotificationTaskRegistrationPromise;
}

void registerBackgroundNotificationTask().catch((error) => {
  logger.warn('Background notification task registration bootstrap failed', { error });
});