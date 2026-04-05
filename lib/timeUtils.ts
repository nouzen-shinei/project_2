import { logger } from '@/lib/logger';
export function formatLastSeen(lastSeen: string | undefined): string {
  if (!lastSeen) return 'Last seen recently';
  
  try {
    const lastSeenDate = new Date(lastSeen);
    const now = new Date();
    
    // Check if the date is valid
    if (isNaN(lastSeenDate.getTime())) {
      return 'Last seen recently';
    }
    
    const diffInMs = now.getTime() - lastSeenDate.getTime();
    const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
    const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
    
    // Less than a minute ago
    if (diffInMinutes < 1) {
      return 'Last seen just now';
    }
    
    // Less than an hour ago
    if (diffInMinutes < 60) {
      return `Last seen ${diffInMinutes} minute${diffInMinutes > 1 ? 's' : ''} ago`;
    }
    
    // Today (same day)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const lastSeenDay = new Date(lastSeenDate);
    lastSeenDay.setHours(0, 0, 0, 0);
    
    if (lastSeenDay.getTime() === today.getTime()) {
      const timeString = lastSeenDate.toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      });
      return `Last seen today at ${timeString}`;
    }
    
    // Yesterday
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    
    if (lastSeenDay.getTime() === yesterday.getTime()) {
      const timeString = lastSeenDate.toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      });
      return `Last seen yesterday at ${timeString}`;
    }
    
    // Within the last week
    if (diffInDays < 7) {
      const dayName = lastSeenDate.toLocaleDateString([], { weekday: 'long' });
      const timeString = lastSeenDate.toLocaleTimeString([], { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: true 
      });
      return `Last seen ${dayName} at ${timeString}`;
    }
    
    // More than a week ago
    const dateString = lastSeenDate.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: lastSeenDate.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
    const timeString = lastSeenDate.toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });
    return `Last seen ${dateString} at ${timeString}`;
    
  } catch (error) {
    logger.warn('Error formatting last seen time:', error);
    return 'Last seen recently';
  }
}

export function formatOnlineStatus(isOnline: boolean | undefined, lastSeen: string | undefined): string {
  if (isOnline === true) {
    return 'Online';
  }

  if (!lastSeen) {
    return 'Offline';
  }

  return formatLastSeen(lastSeen);
}

// WhatsApp-like message timestamp formatting
export function formatMessageTimestamp(timestamp: string): string {
  if (!timestamp) return '';
  
  try {
    const messageDate = new Date(timestamp);
    
    // Check if the date is valid
    if (isNaN(messageDate.getTime())) {
      return messageDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    
    // Always show just the time for all messages
    return messageDate.toLocaleTimeString([], { 
      hour: '2-digit', 
      minute: '2-digit',
      hour12: true 
    });
    
  } catch (error) {
    logger.warn('Error formatting message timestamp:', error);
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

// Get date separator for chat (shows dates between messages when they're on different days)
export function getChatDateSeparator(currentMessageTimestamp: string, previousMessageTimestamp?: string): string | null {
  if (!currentMessageTimestamp) return null;
  
  try {
    const currentDate = new Date(currentMessageTimestamp);
    const now = new Date();
    
    // If there's no previous message, show date separator
    if (!previousMessageTimestamp) {
      return formatChatDateSeparator(currentDate, now);
    }
    
    const previousDate = new Date(previousMessageTimestamp);
    
    // Check if messages are on different days
    const currentDay = new Date(currentDate);
    currentDay.setHours(0, 0, 0, 0);
    const previousDay = new Date(previousDate);
    previousDay.setHours(0, 0, 0, 0);
    
    if (currentDay.getTime() !== previousDay.getTime()) {
      return formatChatDateSeparator(currentDate, now);
    }
    
    return null;
  } catch (error) {
    logger.warn('Error getting chat date separator:', error);
    return null;
  }
}

function formatChatDateSeparator(messageDate: Date, now: Date): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const msgDay = new Date(messageDate);
  msgDay.setHours(0, 0, 0, 0);
  
  const diffInDays = Math.floor((today.getTime() - msgDay.getTime()) / (1000 * 60 * 60 * 24));
  
  // Today
  if (diffInDays === 0) {
    return 'Today';
  }
  
  // Yesterday
  if (diffInDays === 1) {
    return 'Yesterday';
  }
  
  // Within this week (2-6 days ago)
  if (diffInDays <= 6) {
    return messageDate.toLocaleDateString([], { weekday: 'long' });
  }
  
  // This year - show date without year
  if (messageDate.getFullYear() === now.getFullYear()) {
    return messageDate.toLocaleDateString([], {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    });
  }
  
  // Previous years - show full date
  return messageDate.toLocaleDateString([], {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  });
}
