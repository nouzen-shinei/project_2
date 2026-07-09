import { logger } from '@/lib/logger';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface PendingMessage {
  id: string;
  text: string;
  timestamp: string;
  recipientId: string;
  sender: string;
  replyTo?: PendingMessageReplyContext;
  status?: 'queued' | 'sending' | 'sent' | 'failed';
  serverMessageId?: string;
}

export interface PendingMessageReplyContext {
  messageId: string;
  sender: string;
  senderName?: string;
  text?: string;
  isSpecial?: boolean;
  hasAttachments?: boolean;
  attachmentCount?: number;
  hasSticker?: boolean;
  hasGif?: boolean;
}

export interface PendingMediaMessage {
  id: string;
  kind: 'gif' | 'sticker';
  previewUri: string;
  width?: number;
  height?: number;
  nameOrTitle?: string;
  timestamp: string;
  recipientId: string;
  sender: string;
  status: 'sending' | 'failed' | 'queued' | 'sent';
  serverMessageId?: string;
  mime?: string;
  source?: 'keyboard' | 'picker';
  progress?: number;
}

export interface PendingAttachmentMessage {
  id: string;
  files: {
    uri: string;
    fileName: string;
    fileType: string;
    fileSize?: number;
  }[];
  messageText: string;
  timestamp?: string;
  recipientId: string;
  sender: string;
  status: 'sending' | 'failed' | 'finalizing' | 'sent' | 'queued';
  serverMessageId?: string;
  progress: number;
  cancelable?: boolean;
  cancelRequested?: boolean;
  failureReason?: 'error' | 'canceled';
}

const PENDING_MESSAGES_KEY = 'pendingMessages';
const PENDING_MEDIA_KEY = 'pendingMediaMessages';
const PENDING_ATTACHMENTS_KEY = 'pendingAttachmentMessages';

export class PendingMessageStorage {
  private static async saveMap<T>(key: string, messages: Map<string, T>): Promise<void> {
    const messagesArray = Array.from(messages.entries());
    await AsyncStorage.setItem(key, JSON.stringify(messagesArray));
  }

  private static async loadMap<T>(key: string): Promise<Map<string, T>> {
    const stored = await AsyncStorage.getItem(key);
    if (!stored) {
      return new Map<string, T>();
    }
    const messagesArray: [string, T][] = JSON.parse(stored);
    return new Map(messagesArray);
  }
  
  // Save pending messages to storage
  static async savePendingMessages(messages: Map<string, PendingMessage>): Promise<void> {
    try {
      await this.saveMap(PENDING_MESSAGES_KEY, messages);
    } catch (error) {
      logger.error('Error saving pending messages:', error);
    }
  }

  // Load pending messages from storage
  static async loadPendingMessages(): Promise<Map<string, PendingMessage>> {
    try {
      logger.debug('📂 Loading pending messages from storage...');
      const messages = await this.loadMap<PendingMessage>(PENDING_MESSAGES_KEY);
      if (messages.size > 0) {
        logger.debug('📂 Loaded', messages.size, 'pending messages from storage');
        return messages;
      } else {
        logger.debug('📂 No pending messages found in storage');
      }
    } catch (error) {
      logger.error('❌ Error loading pending messages:', error);
    }
    return new Map();
  }

  // Add a single pending message
  static async addPendingMessage(id: string, message: PendingMessage): Promise<void> {
    try {
      logger.debug('💾 Adding pending message to storage:', { id, text: message.text, recipientId: message.recipientId });
      const existingMessages = await this.loadPendingMessages();
      existingMessages.set(id, message);
      await this.savePendingMessages(existingMessages);
      logger.debug('✅ Pending message added successfully. Total messages:', existingMessages.size);
    } catch (error) {
      logger.error('❌ Error adding pending message:', error);
      throw error; // Re-throw so calling code can handle it
    }
  }

  // Remove a single pending message
  static async removePendingMessage(id: string): Promise<void> {
    try {
      const existingMessages = await this.loadPendingMessages();
      existingMessages.delete(id);
      await this.savePendingMessages(existingMessages);
    } catch (error) {
      logger.error('Error removing pending message:', error);
    }
  }

  // Remove multiple pending messages
  static async removePendingMessages(ids: string[]): Promise<void> {
    try {
      logger.debug('🗑️ Removing pending messages from storage:', ids);
      const existingMessages = await this.loadPendingMessages();
      ids.forEach(id => existingMessages.delete(id));
      await this.savePendingMessages(existingMessages);
      logger.debug('✅ Successfully removed pending messages. Remaining:', existingMessages.size);
    } catch (error) {
      logger.error('❌ Error removing pending messages:', error);
      throw error; // Re-throw so calling code can handle it
    }
  }

  // Clear all pending messages
  static async clearAllPendingMessages(): Promise<void> {
    try {
      await AsyncStorage.removeItem(PENDING_MESSAGES_KEY);
    } catch (error) {
      logger.error('Error clearing pending messages:', error);
    }
  }

  // Get pending messages for a specific conversation
  static async getPendingMessagesForRecipient(recipientId: string, sender: string): Promise<Map<string, PendingMessage>> {
    try {
      logger.debug('🔍 Getting pending messages for:', { recipientId, sender });
      const allMessages = await this.loadPendingMessages();
      const filteredMessages = new Map<string, PendingMessage>();
      
      for (const [id, message] of allMessages.entries()) {
        if (message.recipientId === recipientId && message.sender === sender) {
          filteredMessages.set(id, message);
        }
      }
      
      logger.debug('🔍 Found', filteredMessages.size, 'pending messages for this conversation');
      return filteredMessages;
    } catch (error) {
      logger.error('❌ Error getting pending messages for recipient:', error);
      return new Map();
    }
  }

  // Debug method to log all pending messages
  static async debugAllPendingMessages(): Promise<void> {
    try {
      const allMessages = await this.loadPendingMessages();
      logger.debug('🐛 DEBUG: All pending messages in storage:');
      for (const [id, message] of allMessages.entries()) {
        logger.debug('  -', id, ':', {
          text: message.text,
          recipientId: message.recipientId,
          sender: message.sender,
          timestamp: message.timestamp
        });
      }
    } catch (error) {
      logger.error('❌ Error debugging pending messages:', error);
    }
  }

  static async savePendingMediaMessages(messages: Map<string, PendingMediaMessage>): Promise<void> {
    try {
      await this.saveMap(PENDING_MEDIA_KEY, messages);
    } catch (error) {
      logger.error('Error saving pending media messages:', error);
    }
  }

  static async loadPendingMediaMessages(): Promise<Map<string, PendingMediaMessage>> {
    try {
      return await this.loadMap<PendingMediaMessage>(PENDING_MEDIA_KEY);
    } catch (error) {
      logger.error('Error loading pending media messages:', error);
      return new Map<string, PendingMediaMessage>();
    }
  }

  static async savePendingAttachmentMessages(messages: Map<string, PendingAttachmentMessage>): Promise<void> {
    try {
      await this.saveMap(PENDING_ATTACHMENTS_KEY, messages);
    } catch (error) {
      logger.error('Error saving pending attachment messages:', error);
    }
  }

  static async loadPendingAttachmentMessages(): Promise<Map<string, PendingAttachmentMessage>> {
    try {
      return await this.loadMap<PendingAttachmentMessage>(PENDING_ATTACHMENTS_KEY);
    } catch (error) {
      logger.error('Error loading pending attachment messages:', error);
      return new Map<string, PendingAttachmentMessage>();
    }
  }

  static async clearAllPendingMediaMessages(): Promise<void> {
    try {
      await AsyncStorage.removeItem(PENDING_MEDIA_KEY);
    } catch (error) {
      logger.error('Error clearing pending media messages:', error);
    }
  }

  static async clearAllPendingAttachmentMessages(): Promise<void> {
    try {
      await AsyncStorage.removeItem(PENDING_ATTACHMENTS_KEY);
    } catch (error) {
      logger.error('Error clearing pending attachment messages:', error);
    }
  }
}
