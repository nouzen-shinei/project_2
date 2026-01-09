import { logger } from '@/lib/logger';
// Service for persisting WhatsApp conversation state (last inbound timestamps) in Firestore
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { firestore } from '../config/firebase';

export interface WhatsAppConversationState {
  phone: string;             // E.164 number
  lastInboundAt?: number;    // epoch ms of last user message
  lastUpdatedAt: number;     // epoch ms
}

const COLLECTION = 'whatsapp_conversations';

class WhatsAppConversationService {
  private docRef(phone: string) {
    const normalized = phone.replace(/[^+\d]/g, '');
    return doc(firestore, COLLECTION, normalized);
  }

  async getState(phone: string): Promise<WhatsAppConversationState | null> {
    try {
      const snapshot = await getDoc(this.docRef(phone));
      if (snapshot.exists()) return snapshot.data() as WhatsAppConversationState;
      return null;
    } catch (e) {
      logger.error('Failed to fetch WhatsApp conversation state', e);
      return null;
    }
  }

  async setLastInbound(phone: string, timestamp: number): Promise<void> {
    try {
      await setDoc(this.docRef(phone), {
        phone: phone,
        lastInboundAt: timestamp,
        lastUpdatedAt: Date.now(),
      }, { merge: true });
    } catch (e) {
      logger.error('Failed to set last inbound timestamp', e);
    }
  }
}

export const whatsappConversationService = new WhatsAppConversationService();
