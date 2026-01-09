import { logger } from '@/lib/logger';
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface PendingMessage {
  id: string;
  text: string;
  timestamp: string;
  recipientId: string;
  sender: string;
}

const PENDING_MESSAGES_KEY = 'pendingMessages';

export class PendingMessageStorage {
  
  // Save pending messages to storage
  static async savePendingMessages(messages: Map<string, PendingMessage>): Promise<void> {
    try {
      const messagesArray = Array.from(messages.entries());
      await AsyncStorage.setItem(PENDING_MESSAGES_KEY, JSON.stringify(messagesArray));
    } catch (error) {
      logger.error('Error saving pending messages:', error);
    }
  }

  // Load pending messages from storage
  static async loadPendingMessages(): Promise<Map<string, PendingMessage>> {
    try {
      logger.debug('📂 Loading pending messages from storage...');
      const stored = await AsyncStorage.getItem(PENDING_MESSAGES_KEY);
      if (stored) {
        const messagesArray: [string, PendingMessage][] = JSON.parse(stored);
        const messages = new Map(messagesArray);
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
}
