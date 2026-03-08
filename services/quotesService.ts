import { logger } from '@/lib/logger';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { dailyQuoteBackendClient, DailyQuoteBackendStatus } from '@/services/dailyQuoteBackendClient';
import { tenantService } from '@/services/tenantService';

export interface Quote {
  text: string;
  author: string;
  category: string;
  source?: 'local' | 'api' | 'quotable' | 'zenquotes' | 'quotegarden';
  id?: string;
}

export interface QuoteApiResponse {
  success: boolean;
  quote?: Quote;
  error?: string;
}

type QuoteScheduleDetail = {
  identifier: string | null;
  timeOfDay: string | null;
  hasTimer: boolean;
};

interface QuoteScheduleStatus {
  isSchedulingEnabled: boolean;
  platform: typeof Platform.OS;
  nextMorningTriggerAt: string | null;
  nextEveningTriggerAt: string | null;
  scheduledNotificationCount: number;
  details: QuoteScheduleDetail[];
  deliveryMode: 'backend';
  backendStatus?: DailyQuoteBackendStatus | null;
}

// Comprehensive collection of quotes from various categories
const QUOTES_COLLECTION: Quote[] = [
  // Inspirational
  { text: "The only way to do great work is to love what you do.", author: "Steve Jobs", category: "inspirational", source: "local" },
  { text: "Life is what happens to you while you're busy making other plans.", author: "John Lennon", category: "inspirational", source: "local" },
  { text: "The future belongs to those who believe in the beauty of their dreams.", author: "Eleanor Roosevelt", category: "inspirational", source: "local" },
  { text: "It is during our darkest moments that we must focus to see the light.", author: "Aristotle", category: "inspirational", source: "local" },
  { text: "The way to get started is to quit talking and begin doing.", author: "Walt Disney", category: "inspirational", source: "local" },
  
  // Educational
  { text: "Education is the most powerful weapon which you can use to change the world.", author: "Nelson Mandela", category: "educational", source: "local" },
  { text: "The more that you read, the more things you will know. The more that you learn, the more places you'll go.", author: "Dr. Seuss", category: "educational", source: "local" },
  { text: "Tell me and I forget, teach me and I may remember, involve me and I learn.", author: "Benjamin Franklin", category: "educational", source: "local" },
  { text: "Learning never exhausts the mind.", author: "Leonardo da Vinci", category: "educational", source: "local" },
  { text: "The beautiful thing about learning is that nobody can take it away from you.", author: "B.B. King", category: "educational", source: "local" },
  
  // Motivational
  { text: "Believe you can and you're halfway there.", author: "Theodore Roosevelt", category: "motivational", source: "local" },
  { text: "The only impossible journey is the one you never begin.", author: "Tony Robbins", category: "motivational", source: "local" },
  { text: "Success is not final, failure is not fatal: it is the courage to continue that counts.", author: "Winston Churchill", category: "motivational", source: "local" },
  { text: "Don't watch the clock; do what it does. Keep going.", author: "Sam Levenson", category: "motivational", source: "local" },
  { text: "The difference between ordinary and extraordinary is that little extra.", author: "Jimmy Johnson", category: "motivational", source: "local" },
  
  // Wisdom
  { text: "The only true wisdom is in knowing you know nothing.", author: "Socrates", category: "wisdom", source: "local" },
  { text: "Yesterday is history, tomorrow is a mystery, today is a gift of God, which is why we call it the present.", author: "Bill Keane", category: "wisdom", source: "local" },
  { text: "In the middle of difficulty lies opportunity.", author: "Albert Einstein", category: "wisdom", source: "local" },
  { text: "Be yourself; everyone else is already taken.", author: "Oscar Wilde", category: "wisdom", source: "local" },
  { text: "The journey of a thousand miles begins with one step.", author: "Lao Tzu", category: "wisdom", source: "local" },
  
  // Success
  { text: "Success is not how high you have climbed, but how you make a positive difference to the world.", author: "Roy T. Bennett", category: "success", source: "local" },
  { text: "The secret of success is to do the common thing uncommonly well.", author: "John D. Rockefeller Jr.", category: "success", source: "local" },
  { text: "Don't be afraid to give up the good to go for the great.", author: "John D. Rockefeller", category: "success", source: "local" },
  { text: "I find that the harder I work, the more luck I seem to have.", author: "Thomas Jefferson", category: "success", source: "local" },
  { text: "Success is walking from failure to failure with no loss of enthusiasm.", author: "Winston Churchill", category: "success", source: "local" },
  
  // Leadership
  { text: "A leader is one who knows the way, goes the way, and shows the way.", author: "John C. Maxwell", category: "leadership", source: "local" },
  { text: "The art of leadership is saying no, not saying yes. It is very easy to say yes.", author: "Tony Blair", category: "leadership", source: "local" },
  { text: "Leadership is not about being in charge. It is about taking care of those in your charge.", author: "Simon Sinek", category: "leadership", source: "local" },
  { text: "Innovation distinguishes between a leader and a follower.", author: "Steve Jobs", category: "leadership", source: "local" },
  { text: "The greatest leader is not necessarily the one who does the greatest things. He is the one that gets the people to do the greatest things.", author: "Ronald Reagan", category: "leadership", source: "local" },
  
  // Life Lessons
  { text: "Life is 10% what happens to you and 90% how you react to it.", author: "Charles R. Swindoll", category: "life", source: "local" },
  { text: "The purpose of our lives is to be happy.", author: "Dalai Lama", category: "life", source: "local" },
  { text: "You only live once, but if you do it right, once is enough.", author: "Mae West", category: "life", source: "local" },
  { text: "Many of life's failures are people who did not realize how close they were to success when they gave up.", author: "Thomas A. Edison", category: "life", source: "local" },
  { text: "Life is really simple, but we insist on making it complicated.", author: "Confucius", category: "life", source: "local" },
  
  // Perseverance
  { text: "It does not matter how slowly you go as long as you do not stop.", author: "Confucius", category: "perseverance", source: "local" },
  { text: "Fall seven times, stand up eight.", author: "Japanese Proverb", category: "perseverance", source: "local" },
  { text: "The difference between a successful person and others is not a lack of strength, not a lack of knowledge, but rather a lack of will.", author: "Vince Lombardi", category: "perseverance", source: "local" },
  { text: "Perseverance is not a long race; it is many short races one after the other.", author: "Walter Elliot", category: "perseverance", source: "local" },
  { text: "Never give up on a dream just because of the time it will take to accomplish it. The time will pass anyway.", author: "Earl Nightingale", category: "perseverance", source: "local" },
  
  // Creativity
  { text: "Creativity is intelligence having fun.", author: "Albert Einstein", category: "creativity", source: "local" },
  { text: "The secret to creativity is knowing how to hide your sources.", author: "Pablo Picasso", category: "creativity", source: "local" },
  { text: "Innovation is the ability to see change as an opportunity - not a threat.", author: "Steve Jobs", category: "creativity", source: "local" },
  { text: "Creativity takes courage.", author: "Henri Matisse", category: "creativity", source: "local" },
  { text: "The creative adult is the child who survived.", author: "Ursula K. Le Guin", category: "creativity", source: "local" },
  
  // Happiness
  { text: "Happiness is not something ready made. It comes from your own actions.", author: "Dalai Lama", category: "happiness", source: "local" },
  { text: "The secret of happiness is freedom, the secret of freedom is courage.", author: "Carrie Jones", category: "happiness", source: "local" },
  { text: "Happiness depends upon ourselves.", author: "Aristotle", category: "happiness", source: "local" },
  { text: "The best way to cheer yourself up is to try to cheer somebody else up.", author: "Mark Twain", category: "happiness", source: "local" },
  { text: "Happiness is when what you think, what you say, and what you do are in harmony.", author: "Mahatma Gandhi", category: "happiness", source: "local" },
];

export class QuotesService {
  private static instance: QuotesService;
  private scheduledMorningNotificationId: string | null = null;
  private scheduledEveningNotificationId: string | null = null;
  private nextMorningTriggerAt: Date | null = null;
  private nextEveningTriggerAt: Date | null = null;
  private isSchedulingEnabled: boolean = true;
  private apiQuoteCache: Quote[] = [];
  private lastApiCallTime: number = 0;
  private apiCallCooldown: number = 60000; // 1 minute cooldown between API calls
  private useApiQuotes: boolean = true;
  private schedulingPromise: Promise<void> | null = null;

  // Quote APIs configuration
  private quoteApis = [
    {
      name: 'quotable',
      url: 'https://api.quotable.io/random',
      enabled: true,
      requestsPerDay: 1000,
    },
    {
      name: 'zenquotes',
      url: 'https://zenquotes.io/api/random',
      enabled: true,
      requestsPerDay: 100,
    },
    {
      name: 'quotegarden',
      url: 'https://quotegarden.herokuapp.com/api/v3/quotes/random',
      enabled: true,
      requestsPerDay: 1000,
    },
  ];

  private constructor() {
    this.loadCachedApiQuotes();
  }

  static getInstance(): QuotesService {
    if (!QuotesService.instance) {
      QuotesService.instance = new QuotesService();
    }
    return QuotesService.instance;
  }

  /**
   * Load cached API quotes from storage
   */
  private async loadCachedApiQuotes(): Promise<void> {
    try {
      const cached = await AsyncStorage.getItem('apiQuoteCache');
      if (cached) {
        this.apiQuoteCache = JSON.parse(cached);
      }
    } catch (error) {
      logger.error('Failed to load cached API quotes:', error);
    }
  }

  /**
   * Save API quotes to cache
   */
  private async saveCachedApiQuotes(): Promise<void> {
    try {
      await AsyncStorage.setItem('apiQuoteCache', JSON.stringify(this.apiQuoteCache));
    } catch (error) {
      logger.error('Failed to save API quotes cache:', error);
    }
  }

  /**
   * Fetch quote from Quotable API (with CORS handling)
   */
  private async fetchFromQuotable(): Promise<QuoteApiResponse> {
    try {
      // For web platform, use CORS proxy or skip API calls
      if (Platform.OS === 'web') {
        throw new Error('CORS restriction on web platform');
      }

      const response = await fetch('https://api.quotable.io/random', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Quotable API error: ${response.status}`);
      }

      const data = await response.json();
      
      const quote: Quote = {
        text: data.content,
        author: data.author,
        category: this.mapQuotableCategory(data.tags?.[0] || 'inspirational'),
        source: 'quotable',
        id: data._id,
      };

      return { success: true, quote };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Fetch quote from a web-compatible API (JSONPlaceholder-style)
   */
  private async fetchFromWebCompatibleAPI(): Promise<QuoteApiResponse> {
    try {
      // Use a simple web-compatible API for demonstration
      // In production, you might want to use your own backend API
      const quotes = [
        {
          text: "The only way to do great work is to love what you do.",
          author: "Steve Jobs",
          category: "inspirational"
        },
        {
          text: "Innovation distinguishes between a leader and a follower.",
          author: "Steve Jobs", 
          category: "leadership"
        },
        {
          text: "Life is what happens to you while you're busy making other plans.",
          author: "John Lennon",
          category: "life"
        },
        {
          text: "The future belongs to those who believe in the beauty of their dreams.",
          author: "Eleanor Roosevelt",
          category: "inspirational"
        },
        {
          text: "Success is not final, failure is not fatal: it is the courage to continue that counts.",
          author: "Winston Churchill",
          category: "motivational"
        }
      ];

      // Simulate API call with random selection
      const randomQuote = quotes[Math.floor(Math.random() * quotes.length)];
      
      const quote: Quote = {
        text: randomQuote.text,
        author: randomQuote.author,
        category: randomQuote.category,
        source: 'api',
        id: `web-${Date.now()}`,
      };

      // Simulate network delay
      await new Promise(resolve => setTimeout(resolve, 500));

      return { success: true, quote };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Fetch quote from ZenQuotes API (with CORS handling)
   */
  private async fetchFromZenQuotes(): Promise<QuoteApiResponse> {
    try {
      // For web platform, use CORS proxy or skip API calls
      if (Platform.OS === 'web') {
        throw new Error('CORS restriction on web platform');
      }

      const response = await fetch('https://zenquotes.io/api/random', {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`ZenQuotes API error: ${response.status}`);
      }

      const data = await response.json();
      
      if (data && data[0]) {
        const quoteData = data[0];
        const quote: Quote = {
          text: quoteData.q,
          author: quoteData.a,
          category: 'inspirational', // ZenQuotes doesn't provide categories
          source: 'zenquotes',
          id: quoteData.h,
        };

        return { success: true, quote };
      }

      throw new Error('Invalid ZenQuotes response format');
    } catch (error) {
      return { success: false, error: String(error) };
    }
  }

  /**
   * Map Quotable API tags to our categories
   */
  private mapQuotableCategory(tag: string): string {
    const categoryMap: Record<string, string> = {
      'motivational': 'motivational',
      'inspirational': 'inspirational',
      'wisdom': 'wisdom',
      'success': 'success',
      'life': 'life',
      'leadership': 'leadership',
      'education': 'educational',
      'happiness': 'happiness',
      'perseverance': 'perseverance',
      'creativity': 'creativity',
      'famous-quotes': 'inspirational',
      'philosophy': 'wisdom',
      'science': 'educational',
      'technology': 'creativity',
    };

    return categoryMap[tag.toLowerCase()] || 'inspirational';
  }

  /**
   * Fetch fresh quote from API with fallback
   */
  private async fetchFreshQuote(): Promise<Quote> {
    // Check cooldown to avoid API rate limits
    const now = Date.now();
    if (now - this.lastApiCallTime < this.apiCallCooldown) {
      return this.getRandomCachedQuote();
    }

    // For web platform, use web-compatible APIs first
    if (Platform.OS === 'web') {
      try {
        const result = await this.fetchFromWebCompatibleAPI();

        if (result.success && result.quote) {
          this.lastApiCallTime = now;
          
          // Cache the quote
          this.apiQuoteCache.unshift(result.quote);
          
          // Keep cache size reasonable (max 100 quotes)
          if (this.apiQuoteCache.length > 100) {
            this.apiQuoteCache = this.apiQuoteCache.slice(0, 100);
          }
          
          await this.saveCachedApiQuotes();
          
          return result.quote;
        }
      } catch (error) {
        // Web platform falls back to local quotes if APIs don't work
      }

      // Web platform falls back to local quotes if APIs don't work
      return this.getRandomLocalQuote();
    }

    // For mobile platforms, try the external APIs
    const shuffledApis = [...this.quoteApis].sort(() => Math.random() - 0.5);
    
    for (const api of shuffledApis) {
      if (!api.enabled) continue;

      try {
        let result: QuoteApiResponse;

        switch (api.name) {
          case 'quotable':
            result = await this.fetchFromQuotable();
            break;
          case 'zenquotes':
            result = await this.fetchFromZenQuotes();
            break;
          default:
            continue;
        }

        if (result.success && result.quote) {
          this.lastApiCallTime = now;
          
          // Cache the quote
          this.apiQuoteCache.unshift(result.quote);
          
          // Keep cache size reasonable (max 100 quotes)
          if (this.apiQuoteCache.length > 100) {
            this.apiQuoteCache = this.apiQuoteCache.slice(0, 100);
          }
          
          await this.saveCachedApiQuotes();
          
          return result.quote;
        }
      } catch (error) {
        continue;
      }
    }

    // All APIs failed, use cached or local quote
    return this.getRandomCachedQuote();
  }

  /**
   * Get random cached quote or local quote as fallback
   */
  private getRandomCachedQuote(): Quote {
    // First try cached API quotes
    if (this.apiQuoteCache.length > 0) {
      const randomIndex = Math.floor(Math.random() * this.apiQuoteCache.length);
      return this.apiQuoteCache[randomIndex];
    }

    // Fall back to local quotes
    return this.getRandomLocalQuote();
  }

  /**
   * Get random local quote
   */
  private getRandomLocalQuote(): Quote {
    const randomIndex = Math.floor(Math.random() * QUOTES_COLLECTION.length);
    return QUOTES_COLLECTION[randomIndex];
  }

  /**
   * Get a random quote from all categories (enhanced with API integration)
   */
  async getRandomQuote(): Promise<Quote> {
    if (this.useApiQuotes) {
      try {
        return await this.fetchFreshQuote();
      } catch (error) {
        logger.error('Failed to fetch fresh quote:', error);
        return this.getRandomLocalQuote();
      }
    } else {
      return this.getRandomLocalQuote();
    }
  }

  /**
   * Get a random quote from a specific category (enhanced with API integration)
   */
  async getRandomQuoteByCategory(category: string): Promise<Quote> {
    // First try to get from cached API quotes of this category
    const cachedCategoryQuotes = this.apiQuoteCache.filter(quote => quote.category === category);
    
    if (cachedCategoryQuotes.length > 0 && Math.random() > 0.5) {
      const randomIndex = Math.floor(Math.random() * cachedCategoryQuotes.length);
      return cachedCategoryQuotes[randomIndex];
    }

    // Try to fetch a fresh quote (it might not be the exact category due to API limitations)
    if (this.useApiQuotes) {
      try {
        const freshQuote = await this.fetchFreshQuote();
        if (freshQuote.category === category) {
          return freshQuote;
        }
      } catch (error) {
        logger.error('Failed to fetch fresh quote for category:', error);
      }
    }

    // Fall back to local quotes for the category
    const localCategoryQuotes = QUOTES_COLLECTION.filter(quote => quote.category === category);
    if (localCategoryQuotes.length === 0) {
      return await this.getRandomQuote(); // Fallback to any quote
    }
    
    const randomIndex = Math.floor(Math.random() * localCategoryQuotes.length);
    return localCategoryQuotes[randomIndex];
  }

  /**
   * Get all available categories (enhanced with API quotes)
   */
  getCategories(): string[] {
    const localCategories = new Set(QUOTES_COLLECTION.map(quote => quote.category));
    const apiCategories = new Set(this.apiQuoteCache.map(quote => quote.category));
    const allCategories = new Set([...localCategories, ...apiCategories]);
    return Array.from(allCategories).sort();
  }

  /**
   * Get quotes for a specific category (enhanced with API quotes)
   */
  getQuotesByCategory(category: string): Quote[] {
    const localQuotes = QUOTES_COLLECTION.filter(quote => quote.category === category);
    const apiQuotes = this.apiQuoteCache.filter(quote => quote.category === category);
    return [...localQuotes, ...apiQuotes];
  }

  /**
   * Schedule daily quote notifications (morning and evening)
   */
  async scheduleQuoteNotifications(): Promise<void> {
    if (!this.isSchedulingEnabled) {
      return;
    }

    try {
      await this.cancelQuoteNotifications();
    } catch (error) {
      logger.warn('Failed to clear legacy quote notifications before backend scheduling:', error);
    }

    this.scheduledMorningNotificationId = null;
    this.scheduledEveningNotificationId = null;
    this.nextMorningTriggerAt = null;
    this.nextEveningTriggerAt = null;

    if (this.useApiQuotes) {
      try {
        await this.prefetchQuotes(Platform.OS === 'web' ? 2 : 3);
      } catch (error) {
        logger.debug('Quote prefetch skipped during backend scheduling preparation:', error);
      }
    }

    logger.debug('Daily quote notifications handled by backend runtime for all platforms.');
  }

  /**
   * Cancel all scheduled quote notifications
   */
  async cancelQuoteNotifications(): Promise<void> {
    try {
      if (Platform.OS !== 'web') {
        // Cancel mobile notifications
        if (this.scheduledMorningNotificationId) {
          await Notifications.cancelScheduledNotificationAsync(this.scheduledMorningNotificationId);
          this.scheduledMorningNotificationId = null;
        }

        if (this.scheduledEveningNotificationId) {
          await Notifications.cancelScheduledNotificationAsync(this.scheduledEveningNotificationId);
          this.scheduledEveningNotificationId = null;
        }

        // Cancel any existing daily quote notifications
        const scheduledNotifications = await Notifications.getAllScheduledNotificationsAsync();
        const quoteNotificationIds = scheduledNotifications
          .filter(notif => notif.content.data?.type === 'daily_quote')
          .map(notif => notif.identifier);

        for (const id of quoteNotificationIds) {
          await Notifications.cancelScheduledNotificationAsync(id);
        }
      }

      this.nextMorningTriggerAt = null;
      this.nextEveningTriggerAt = null;
    } catch (error) {
      logger.error('Failed to cancel quote notifications:', error);
    }
  }

  /**
   * Trigger immediate backend quote delivery for the active tenant.
   */
  async sendImmediateQuote(category?: string): Promise<void> {
    try {
      const tenantId = await tenantService.getCachedSelectedTenant();
      if (!tenantId) {
        logger.warn('Cannot trigger backend daily quote without tenant context');
        return;
      }
      const response = await dailyQuoteBackendClient.trigger({
        tenantId,
        timeOfDay: 'immediate',
        reason: category ? `immediate:${category}` : 'immediate',
      });

      if (!response.ok) {
        logger.warn('Backend immediate quote trigger failed', response.error);
      }
    } catch (error) {
      logger.error('Failed to send immediate quote:', error);
    }
  }

  /**
   * Enable or disable API quotes
   */
  setUseApiQuotes(enabled: boolean): void {
    this.useApiQuotes = enabled;
    if (enabled) {
      this.prefetchQuotes(5); // Prefetch some quotes when enabling
    }
  }

  /**
   * Check if API quotes are enabled
   */
  isUsingApiQuotes(): boolean {
    return this.useApiQuotes;
  }

  /**
   * Prefetch quotes for better performance
   */
  async prefetchQuotes(count: number = 10): Promise<void> {
    // Reduce count for web platform to avoid overwhelming
    const actualCount = Platform.OS === 'web' ? Math.min(count, 3) : count;
    
    for (let i = 0; i < actualCount; i++) {
      try {
        await this.fetchFreshQuote();
        // Longer delay for web platform to be more respectful
        const delay = Platform.OS === 'web' ? 2000 : 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      } catch (error) {
        // On error, break early to avoid overwhelming the system
        break;
      }
    }
  }

  /**
   * Enable or disable quote scheduling
   */
  async setSchedulingEnabled(enabled: boolean): Promise<void> {
    this.isSchedulingEnabled = enabled;
    if (!enabled) {
      await this.cancelQuoteNotifications();
    } else {
      await this.scheduleQuoteNotifications();
    }
  }

  /**
   * Check if scheduling is enabled
   */
  isSchedulingEnabledStatus(): boolean {
    return this.isSchedulingEnabled;
  }

  /**
   * Get quote statistics (enhanced with API quotes)
   */
  getQuoteStats(): {
    totalQuotes: number;
    localQuotes: number;
    apiQuotes: number;
    categories: string[];
    quotesPerCategory: Record<string, number>;
    usingApiQuotes: boolean;
    lastApiCall: string;
    apiCacheSize: number;
  } {
    const categories = this.getCategories();
    const quotesPerCategory: Record<string, number> = {};

    categories.forEach(category => {
      quotesPerCategory[category] = this.getQuotesByCategory(category).length;
    });

    return {
      totalQuotes: QUOTES_COLLECTION.length + this.apiQuoteCache.length,
      localQuotes: QUOTES_COLLECTION.length,
      apiQuotes: this.apiQuoteCache.length,
      categories,
      quotesPerCategory,
      usingApiQuotes: this.useApiQuotes,
      lastApiCall: this.lastApiCallTime > 0 ? new Date(this.lastApiCallTime).toLocaleString() : 'Never',
      apiCacheSize: this.apiQuoteCache.length,
    };
  }

  /**
   * Clear API cache
   */
  async clearApiCache(): Promise<void> {
    this.apiQuoteCache = [];
    await AsyncStorage.removeItem('apiQuoteCache');
  }

  async getQuoteScheduleStatus(): Promise<QuoteScheduleStatus> {
    const status: QuoteScheduleStatus = {
      isSchedulingEnabled: this.isSchedulingEnabled,
      platform: Platform.OS,
      nextMorningTriggerAt: this.nextMorningTriggerAt ? this.nextMorningTriggerAt.toISOString() : null,
      nextEveningTriggerAt: this.nextEveningTriggerAt ? this.nextEveningTriggerAt.toISOString() : null,
      scheduledNotificationCount: 0,
      details: [],
      deliveryMode: 'backend',
      backendStatus: undefined,
    };

    try {
      const backendStatus = await dailyQuoteBackendClient.getStatus();
      status.backendStatus = backendStatus;
      if (backendStatus?.lastRunStats) {
        status.scheduledNotificationCount = backendStatus.lastRunStats.attemptedDeliveries ?? 0;
        status.details = backendStatus.lastRunStats.recipientsSample.map(rec => ({
          identifier: `${rec.userEmail}:${rec.deviceId}`,
          timeOfDay: rec.timeOfDay,
          hasTimer: true,
        }));
        status.nextMorningTriggerAt = backendStatus.nextRunByTimeOfDay?.morning ?? status.nextMorningTriggerAt;
        status.nextEveningTriggerAt = backendStatus.nextRunByTimeOfDay?.evening ?? status.nextEveningTriggerAt;
      }
    } catch (error) {
      logger.warn('Failed to fetch backend daily quote status:', error);
    }

    return status;
  }

  /**
   * Initialize the quotes service (load cache but don't schedule)
   */
  async initialize(): Promise<void> {
    await this.loadCachedApiQuotes();
    
    // Don't auto-schedule on initialization to prevent quotes on app launch
    // Scheduling will only happen when user explicitly enables it via toggleDailyQuotes
    logger.debug('Quotes service initialized. Scheduling enabled:', this.isSchedulingEnabled);
  }

  /**
   * Cleanup the quotes service
   */
  async cleanup(): Promise<void> {
    await this.cancelQuoteNotifications();
    await this.saveCachedApiQuotes();
  }

}

export const quotesService = QuotesService.getInstance();
