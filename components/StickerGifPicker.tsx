import { logger } from '@/lib/logger';
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Image,
  TextInput,
  ActivityIndicator,
  Dimensions,
  Alert,
  Platform,
} from 'react-native';
import { X, Search, Smile, Star } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';

interface StickerPack {
  id: string;
  name: string;
  preview: string;
  stickers: Sticker[];
}

interface Sticker {
  id: string;
  url: string;
  name: string;
  pack: string;
  width?: number;
  height?: number;
}

interface GifData {
  id: string;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  title: string;
  source: string;
}

interface StickerGifPickerProps {
  visible: boolean;
  onClose: () => void;
  onSelectSticker: (sticker: Sticker) => void;
  onSelectGif: (gif: GifData) => void;
}

const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

// Responsive sizing based on screen dimensions
const getItemSize = () => {
  // For tablets/larger screens, use more columns
  if (screenWidth > 768) {
    return (screenWidth - 80) / 5; // 5 columns for tablets
  } else if (screenWidth > 600) {
    return (screenWidth - 70) / 4; // 4 columns for medium screens
  } else {
    return (screenWidth - 60) / 3; // 3 columns for phones
  }
};

const ITEM_SIZE = getItemSize();
const STICKER_SIZE = ITEM_SIZE * 0.85; // Slightly smaller than grid item
const GIF_SIZE = ITEM_SIZE * 0.9; // Slightly larger for GIFs

// Tenor API configuration
const TENOR_API_KEY = process.env.EXPO_PUBLIC_TENOR_API_KEY;
const TENOR_BASE_URL = 'https://tenor.googleapis.com/v2';

// Sticker categories for Tenor API (focusing on static/emoji-like content)
const STICKER_CATEGORIES = [
  { id: 'trending', name: 'Trending', searchTerm: 'emoji face reactions sticker', preview: '🔥' },
  { id: 'reactions', name: 'Reactions', searchTerm: 'emoji reactions faces happy sad angry surprised', preview: '😂' },
  { id: 'love', name: 'Love', searchTerm: 'heart love emoji valentine romantic', preview: '❤️' },
  { id: 'animals', name: 'Animals', searchTerm: 'cute animal emoji cat dog', preview: '🐱' },
  { id: 'celebrations', name: 'Party', searchTerm: 'party celebration emoji birthday confetti', preview: '🎉' },
  { id: 'activities', name: 'Activities', searchTerm: 'sports activities emoji games', preview: '⚽' },
  { id: 'thumbs', name: 'Thumbs', searchTerm: 'thumbs up down like emoji approval', preview: '👍' },
  { id: 'greeting', name: 'Greetings', searchTerm: 'hello hi bye wave emoji hand', preview: '👋' },
];

// Convert Tenor response to our sticker format
interface TenorResult {
  id: string;
  title: string;
  media_formats: {
    gif?: { url: string; dims: number[]; size: number; duration?: number };
    mediumgif?: { url: string; dims: number[]; size: number };
    tinygif?: { url: string; dims: number[]; size: number };
    nanogif?: { url: string; dims: number[]; size: number };
    webp?: { url: string; dims: number[]; size: number };
    tinywebp?: { url: string; dims: number[]; size: number };
    mp4?: { url: string; dims: number[]; size: number };
    loopedmp4?: { url: string; dims: number[]; size: number };
    preview?: string;
  };
  tags: string[];
  content_description?: string;
}

interface TenorResponse {
  results: TenorResult[];
  next?: string;
}

export function StickerGifPicker({
  visible,
  onClose,
  onSelectSticker,
  onSelectGif,
}: StickerGifPickerProps) {
  const { theme } = useTheme();
  const [activeTab, setActiveTab] = useState<'stickers' | 'gifs'>('stickers');
  const [selectedCategory, setSelectedCategory] = useState(STICKER_CATEGORIES[0]);
  const [searchQuery, setSearchQuery] = useState('');
  const [stickers, setStickers] = useState<Sticker[]>([]);
  const [gifs, setGifs] = useState<GifData[]>([]);
  const [isLoadingStickers, setIsLoadingStickers] = useState(false);
  const [isLoadingGifs, setIsLoadingGifs] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [nextStickerPos, setNextStickerPos] = useState<string | null>(null);
  const [nextGifPos, setNextGifPos] = useState<string | null>(null);
  const [hasMoreStickers, setHasMoreStickers] = useState(true);
  const [hasMoreGifs, setHasMoreGifs] = useState(true);
  const scrollViewRef = useRef<ScrollView>(null);

  // Convert Tenor result to Sticker format
  // On native builds, WebP rendering can be limited; prefer GIF variants for reliability.
  const convertTenorToSticker = (result: TenorResult): Sticker => {
    const isWeb = Platform.OS === 'web';
    const webFirst =
      result.media_formats.webp?.url ||
      result.media_formats.tinywebp?.url ||
      result.media_formats.gif?.url ||
      result.media_formats.mediumgif?.url ||
      result.media_formats.tinygif?.url ||
      result.media_formats.nanogif?.url ||
      '';

    const nativeFirst =
      result.media_formats.tinygif?.url ||
      result.media_formats.nanogif?.url ||
      result.media_formats.gif?.url ||
      result.media_formats.mediumgif?.url ||
      result.media_formats.webp?.url ||
      result.media_formats.tinywebp?.url ||
      '';

    const url = isWeb ? webFirst : nativeFirst;

    const dims =
      (isWeb ? result.media_formats.webp?.dims : result.media_formats.tinygif?.dims) ||
      result.media_formats.gif?.dims ||
      result.media_formats.mediumgif?.dims ||
      result.media_formats.tinywebp?.dims ||
      result.media_formats.nanogif?.dims ||
      [150, 150];

    return {
      id: result.id,
      url,
      name: result.title || result.content_description || 'Sticker',
      pack: selectedCategory.id,
      width: dims[0] || 150,
      height: dims[1] || 150,
    };
  };

  // Convert Tenor result to GIF format (prefer animated formats)
  const convertTenorToGif = (result: TenorResult): GifData => ({
    id: result.id,
    // For GIFs, prefer full animated formats
    url: result.media_formats.gif?.url || result.media_formats.mediumgif?.url || result.media_formats.mp4?.url || '',
    thumbnailUrl: result.media_formats.tinygif?.url || result.media_formats.nanogif?.url || result.media_formats.gif?.url || '',
    width: result.media_formats.gif?.dims[0] || 480,
    height: result.media_formats.gif?.dims[1] || 270,
    title: result.title || result.content_description || 'GIF',
    source: 'tenor',
  });

  // Fetch stickers from Tenor API
  const fetchStickers = async (searchTerm?: string, isLoadMore = false) => {
    if (!TENOR_API_KEY) {
      logger.warn('Tenor API key not found');
      return;
    }

    if (isLoadMore) {
      setIsLoadingMore(true);
    } else {
      setIsLoadingStickers(true);
      setStickers([]);
      setNextStickerPos(null);
      setHasMoreStickers(true);
    }

    try {
  const query = searchTerm || selectedCategory.searchTerm;
  let url = `${TENOR_BASE_URL}/search?q=${encodeURIComponent(query)}&key=${TENOR_API_KEY}&limit=20&searchfilter=sticker&media_filter=basic`;
      
      if (isLoadMore && nextStickerPos) {
        url += `&pos=${nextStickerPos}`;
      }
      
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data: TenorResponse = await response.json();
      
      // Filter results that have media formats
      const validResults = data.results.filter(result => 
        result.media_formats && 
        Object.keys(result.media_formats).length > 0
      );
      
      const stickerResults = validResults.map(convertTenorToSticker);
      
      if (isLoadMore) {
        setStickers(prev => [...prev, ...stickerResults]);
      } else {
        setStickers(stickerResults);
      }
      
      // Update pagination
      setNextStickerPos(data.next || null);
      setHasMoreStickers(!!data.next && stickerResults.length > 0);
      
    } catch (error) {
      logger.error('Error fetching stickers:', error);
      if (!isLoadMore) {
        Alert.alert('Error', 'Failed to load stickers. Please check your connection.');
      }
    } finally {
      setIsLoadingStickers(false);
      setIsLoadingMore(false);
    }
  };

  // Fetch GIFs from Tenor API
  const fetchGifs = async (searchTerm?: string, isLoadMore = false) => {
    if (!TENOR_API_KEY) {
      logger.warn('Tenor API key not found');
      return;
    }

    if (isLoadMore) {
      setIsLoadingMore(true);
    } else {
      setIsLoadingGifs(true);
      setGifs([]);
      setNextGifPos(null);
      setHasMoreGifs(true);
    }

    try {
      const query = searchTerm || 'trending';
      let url = `${TENOR_BASE_URL}/search?q=${encodeURIComponent(query)}&key=${TENOR_API_KEY}&limit=20&media_filter=gif`;
      
      if (isLoadMore && nextGifPos) {
        url += `&pos=${nextGifPos}`;
      }
      
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data: TenorResponse = await response.json();
      
      const gifResults = data.results.map(convertTenorToGif);
      
      if (isLoadMore) {
        setGifs(prev => [...prev, ...gifResults]);
      } else {
        setGifs(gifResults);
      }
      
      // Update pagination
      setNextGifPos(data.next || null);
      setHasMoreGifs(!!data.next && gifResults.length > 0);
      
    } catch (error) {
      logger.error('Error fetching GIFs:', error);
      if (!isLoadMore) {
        Alert.alert('Error', 'Failed to load GIFs. Please check your connection.');
      }
    } finally {
      setIsLoadingGifs(false);
      setIsLoadingMore(false);
    }
  };

  // Handle infinite scroll
  const handleScroll = (event: any) => {
    const { layoutMeasurement, contentOffset, contentSize } = event.nativeEvent;
    const paddingToBottom = 100; // Load more when 100px from bottom
    
    if (layoutMeasurement.height + contentOffset.y >= contentSize.height - paddingToBottom) {
      if (activeTab === 'stickers' && hasMoreStickers && !isLoadingMore && !isLoadingStickers) {
        fetchStickers(searchQuery || undefined, true);
      } else if (activeTab === 'gifs' && hasMoreGifs && !isLoadingMore && !isLoadingGifs) {
        fetchGifs(searchQuery || undefined, true);
      }
    }
  };

  // Filter stickers based on search
  const filteredStickers = stickers.filter((sticker: Sticker) => {
    if (!searchQuery.trim()) return true; // Show all when no search query
    const searchLower = searchQuery.toLowerCase();
    return (
      sticker.name.toLowerCase().includes(searchLower) ||
      sticker.pack.toLowerCase().includes(searchLower)
    );
  });

  // Filter GIFs based on search
  const filteredGifs = gifs.filter((gif: GifData) => {
    if (!searchQuery.trim()) return true; // Show all when no search query
    const searchLower = searchQuery.toLowerCase();
    return (
      gif.title.toLowerCase().includes(searchLower) ||
      gif.source.toLowerCase().includes(searchLower)
    );
  });

  // Debug logging for filtered results
  useEffect(() => {
    // Removed debug logs for cleaner console output
  }, [stickers, gifs, filteredStickers, filteredGifs, searchQuery]);

  // Handle search with debouncing
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (activeTab === 'stickers') {
        if (searchQuery.trim()) {
          fetchStickers(searchQuery);
        } else {
          fetchStickers();
        }
      } else {
        if (searchQuery.trim()) {
          fetchGifs(searchQuery);
        } else {
          fetchGifs();
        }
      }
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [searchQuery, activeTab, selectedCategory]);

  // Load initial content when tab changes or category changes
  useEffect(() => {
    if (visible) {
      if (activeTab === 'stickers') {
        fetchStickers();
      } else {
        fetchGifs();
      }
    }
  }, [visible, activeTab, selectedCategory]);

  const handleStickerSelect = (sticker: Sticker) => {
    onSelectSticker(sticker);
    onClose();
  };

  const handleGifSelect = (gif: GifData) => {
    onSelectGif(gif);
    onClose();
  };

  if (!visible) return null;

  const styles = StyleSheet.create({
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.5)',
      justifyContent: 'flex-end',
      zIndex: 1000,
    },
    container: {
      backgroundColor: theme.surface,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      height: '80%',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    title: {
      fontSize: 18,
      fontWeight: '600',
      color: theme.text,
    },
    closeButton: {
      padding: 8,
      borderRadius: 8,
      backgroundColor: theme.background,
    },
    tabContainer: {
      flexDirection: 'row',
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    tab: {
      flex: 1,
      paddingVertical: 12,
      alignItems: 'center',
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
    },
    activeTab: {
      borderBottomColor: theme.primary,
    },
    tabText: {
      fontSize: 16,
      fontWeight: '500',
      color: theme.textSecondary,
    },
    activeTabText: {
      color: theme.primary,
    },
    searchContainer: {
      padding: 16,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    searchInput: {
      backgroundColor: theme.background,
      borderRadius: 8,
      padding: 12,
      fontSize: 16,
      color: theme.text,
      borderWidth: 1,
      borderColor: theme.border,
    },
    content: {
      flex: 1,
    },
    stickerPacksContainer: {
      flexDirection: 'row',
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
      backgroundColor: theme.surface,
    },
    packButton: {
      alignItems: 'center',
      height: 50,
      justifyContent: 'center',
      paddingHorizontal: 12,
      paddingVertical: 4,
      marginHorizontal: 4,
      borderRadius: 12,
      minWidth: 60,
      borderWidth: 1,
      borderColor: theme.border,
      backgroundColor: theme.background,
    },
    activePack: {
      backgroundColor: theme.primary + '20',
      borderColor: theme.primary,
    },
    packPreview: {
      fontSize: 18,
      marginBottom: 2,
    },
    packName: {
      fontSize: 10,
      fontWeight: '500',
      color: theme.textSecondary,
      textAlign: 'center',
    },
    activePackName: {
      color: theme.primary,
      fontWeight: '600',
    },
    grid: {
      padding: 8,
      flex: 2, // Increased flex to make sticker preview area taller
      minHeight: 300, // Ensures a minimum height for the sticker grid
    },
    gridItem: {
      width: ITEM_SIZE,
      height: ITEM_SIZE,
      margin: 4,
      borderRadius: 8,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: theme.background,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.1,
      shadowRadius: 2,
      elevation: 2,
    },
    stickerText: {
      fontSize: 32,
    },
    stickerImage: {
      width: '100%',
      height: '100%',
      borderRadius: 8,
    },
    gifImage: {
      width: '100%',
      height: '100%',
      borderRadius: 8,
    },
    loadingMoreContainer: {
      padding: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    loadingMoreText: {
      marginTop: 8,
      fontSize: 14,
      color: theme.textSecondary,
    },
    loadingContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },
    loadingText: {
      marginTop: 12,
      fontSize: 16,
      color: theme.textSecondary,
    },
    emptyContainer: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 32,
    },
    emptyText: {
      fontSize: 16,
      color: theme.textSecondary,
      textAlign: 'center',
    },
  });

  return (
    <View style={styles.overlay}>
      <TouchableOpacity style={{ flex: 1 }} onPress={onClose} />
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>
            {activeTab === 'stickers' ? 'Stickers' : 'GIFs'}
          </Text>
          <TouchableOpacity style={styles.closeButton} onPress={onClose}>
            <X size={20} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>

        {/* Tabs */}
        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'stickers' && styles.activeTab]}
            onPress={() => setActiveTab('stickers')}
          >
            <Smile
              size={20}
              color={activeTab === 'stickers' ? theme.primary : theme.textSecondary}
            />
            <Text
              style={[
                styles.tabText,
                activeTab === 'stickers' && styles.activeTabText,
              ]}
            >
              Stickers
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'gifs' && styles.activeTab]}
            onPress={() => setActiveTab('gifs')}
          >
            <Star
              size={20}
              color={activeTab === 'gifs' ? theme.primary : theme.textSecondary}
            />
            <Text
              style={[styles.tabText, activeTab === 'gifs' && styles.activeTabText]}
            >
              GIFs
            </Text>
          </TouchableOpacity>
        </View>

        {/* Search */}
        <View style={styles.searchContainer}>
          <View style={{ position: 'relative' }}>
            <TextInput
              style={styles.searchInput}
              placeholder={`Search ${activeTab}...`}
              placeholderTextColor={theme.textSecondary}
              value={searchQuery}
              onChangeText={setSearchQuery}
            />
            <Search
              size={20}
              color={theme.textSecondary}
              style={{
                position: 'absolute',
                right: 12,
                top: 12,
              }}
            />
          </View>
        </View>

        {/* Content */}
        <View style={styles.content}>
          {activeTab === 'stickers' ? (
            <>
        {/* Sticker Categories - sticky at top */}
        <View style={{ zIndex: 2 }}>
          <ScrollView
            horizontal
            style={styles.stickerPacksContainer}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 4 }}
          >
            {STICKER_CATEGORIES.map(category => (
              <TouchableOpacity
                key={category.id}
                style={[
                  styles.packButton,
                  selectedCategory.id === category.id && styles.activePack,
                ]}
                onPress={() => setSelectedCategory(category)}
              >
                <Text style={styles.packPreview}>{category.preview}</Text>
                <Text style={[
                  styles.packName,
                  selectedCategory.id === category.id && styles.activePackName,
                ]}>
                  {category.name}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

              {/* Stickers Grid - below sticky categories */}
              <ScrollView 
                ref={scrollViewRef}
                style={[styles.grid, { marginTop: 0 }]}
                showsVerticalScrollIndicator={false}
                onScroll={handleScroll}
                scrollEventThrottle={16}
              >
                {isLoadingStickers ? (
                  <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={theme.primary} />
                    <Text style={styles.loadingText}>Loading stickers...</Text>
                  </View>
                ) : (
                  <>
                    <View
                      style={{
                        flexDirection: 'row',
                        flexWrap: 'wrap',
                        justifyContent: 'space-between',
                      }}
                    >
                      {filteredStickers.map((sticker: Sticker) => (
                        <TouchableOpacity
                          key={sticker.id}
                          style={styles.gridItem}
                          onPress={() => handleStickerSelect(sticker)}
                        >
                          <Image
                            source={{ uri: sticker.url }}
                            style={styles.stickerImage}
                            resizeMode="contain"
                          />
                        </TouchableOpacity>
                      ))}
                    </View>
                    {isLoadingMore && (
                      <View style={styles.loadingMoreContainer}>
                        <ActivityIndicator size="small" color={theme.primary} />
                        <Text style={styles.loadingMoreText}>Loading more...</Text>
                      </View>
                    )}
                  </>
                )}
                {!isLoadingStickers && filteredStickers.length === 0 && (
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>
                      {searchQuery
                        ? `No stickers found for "${searchQuery}"`
                        : 'No stickers available'}
                    </Text>
                  </View>
                )}
              </ScrollView>
            </>
          ) : (
            // GIFs Grid
            <ScrollView 
              ref={scrollViewRef}
              style={styles.grid} 
              showsVerticalScrollIndicator={false}
              onScroll={handleScroll}
              scrollEventThrottle={16}
            >
              {isLoadingGifs ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator size="large" color={theme.primary} />
                  <Text style={styles.loadingText}>Loading GIFs...</Text>
                </View>
              ) : (
                <>
                  <View
                    style={{
                      flexDirection: 'row',
                      flexWrap: 'wrap',
                      justifyContent: 'space-between',
                    }}
                  >
                    {filteredGifs.map((gif: GifData) => (
                      <TouchableOpacity
                        key={gif.id}
                        style={[styles.gridItem, { height: ITEM_SIZE * 0.75 }]}
                        onPress={() => handleGifSelect(gif)}
                      >
                        <Image
                          source={{ uri: gif.thumbnailUrl }}
                          style={styles.gifImage}
                          resizeMode="cover"
                        />
                      </TouchableOpacity>
                    ))}
                  </View>
                  {isLoadingMore && (
                    <View style={styles.loadingMoreContainer}>
                      <ActivityIndicator size="small" color={theme.primary} />
                      <Text style={styles.loadingMoreText}>Loading more...</Text>
                    </View>
                  )}
                </>
              )}
              {!isLoadingGifs && filteredGifs.length === 0 && (
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyText}>
                    {searchQuery
                      ? `No GIFs found for "${searchQuery}"`
                      : 'No GIFs available'}
                  </Text>
                </View>
              )}
            </ScrollView>
          )}
        </View>
      </View>
    </View>
  );
}
