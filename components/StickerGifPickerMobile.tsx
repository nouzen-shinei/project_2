import { logger } from '@/lib/logger';
import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  TextInput,
  ActivityIndicator,
  Dimensions,
  Alert,
  Platform,
  FlatList,
  ScrollView,
} from 'react-native';
import { X, Search, Smile, Star } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';

interface StickerPack {
  id: string;
  name: string;
  preview: string;
  searchTerm: string;
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

interface StickerGifPickerMobileProps {
  visible: boolean;
  onClose: () => void;
  onSelectSticker: (sticker: Sticker) => void;
  onSelectGif: (gif: GifData) => void;
}

const { width: screenWidth } = Dimensions.get('window');

// Responsive sizing based on screen dimensions
const getItemSize = () => {
  const padding = 16; // Total horizontal padding (8 on each side)
  const spacing = 8; // Total spacing between items
  
  if (screenWidth > 768) {
    // Tablets: 5 columns
    const numColumns = 5;
    return (screenWidth - padding - (spacing * (numColumns - 1))) / numColumns;
  } else if (screenWidth > 600) {
    // Medium screens: 4 columns  
    const numColumns = 4;
    return (screenWidth - padding - (spacing * (numColumns - 1))) / numColumns;
  } else if (screenWidth > 400) {
    // Large phones: 4 columns
    const numColumns = 4;
    return (screenWidth - padding - (spacing * (numColumns - 1))) / numColumns;
  } else {
    // Small phones: 3 columns
    const numColumns = 3;
    return (screenWidth - padding - (spacing * (numColumns - 1))) / numColumns;
  }
};

const getNumColumns = () => {
  if (screenWidth > 768) return 5;
  if (screenWidth > 600) return 4;
  if (screenWidth > 400) return 4;
  return 3;
};

const ITEM_SIZE = getItemSize();
const NUM_COLUMNS = getNumColumns();

// Tenor API configuration
const TENOR_API_KEY = process.env.EXPO_PUBLIC_TENOR_API_KEY;
const TENOR_BASE_URL = 'https://tenor.googleapis.com/v2';

// Sticker categories for Tenor API
const STICKER_CATEGORIES: StickerPack[] = [
  { id: 'trending', name: 'Trending', searchTerm: 'emoji face reactions sticker', preview: '🔥' },
  { id: 'reactions', name: 'Reactions', searchTerm: 'emoji reactions faces happy sad angry surprised', preview: '😂' },
  { id: 'love', name: 'Love', searchTerm: 'heart love emoji valentine romantic', preview: '❤️' },
  { id: 'animals', name: 'Animals', searchTerm: 'cute animal emoji cat dog', preview: '🐱' },
  { id: 'celebrations', name: 'Party', searchTerm: 'party celebration emoji birthday confetti', preview: '🎉' },
  { id: 'activities', name: 'Activities', searchTerm: 'sports activities emoji games', preview: '⚽' },
  { id: 'thumbs', name: 'Thumbs', searchTerm: 'thumbs up down like emoji approval', preview: '👍' },
  { id: 'greeting', name: 'Greetings', searchTerm: 'hello hi bye wave emoji hand', preview: '👋' },
];

// Convert Tenor response interfaces
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
  nanowebp?: { url: string; dims: number[]; size: number };
  mp4?: { url: string; dims: number[]; size: number };
  tinymp4?: { url: string; dims: number[]; size: number };
  nanomp4?: { url: string; dims: number[]; size: number };
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

// Enhanced image cache with size limit for mobile
const imageCache = new Map<string, boolean>();
const MAX_CACHE_SIZE = 200; // Limit cache size for mobile

const OptimizedImage = React.memo(function OptimizedImage({
  source, 
  style, 
  resizeMode 
}: {
  source: { uri: string };
  style: any;
  resizeMode: any;
}) {
  const [loading, setLoading] = useState(!imageCache.has(source.uri));
  const [error, setError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const handleLoad = useCallback(() => {
    // Manage cache size for mobile memory efficiency
    if (imageCache.size >= MAX_CACHE_SIZE) {
      const firstKey = imageCache.keys().next().value;
      if (firstKey) imageCache.delete(firstKey);
    }
    imageCache.set(source.uri, true);
    setLoading(false);
    setError(false);
  }, [source.uri]);

  const handleError = useCallback(() => {
    logger.debug('🚫 Image load error:', source.uri);
    if (retryCount < 1) { // Reduced retries to prevent excessive network calls
      // Retry loading with delay
      setTimeout(() => {
        setRetryCount(prev => prev + 1);
        setError(false);
        setLoading(true);
      }, 1000 * (retryCount + 1));
    } else {
      setError(true);
      setLoading(false);
    }
  }, [retryCount, source.uri]);

  // Reset error state when source changes
  useEffect(() => {
    if (imageCache.has(source.uri)) {
      setLoading(false);
      setError(false);
      setRetryCount(0);
    } else {
      setLoading(true);
      setError(false);
      setRetryCount(0);
    }
  }, [source.uri]);

  if (error) {
    return (
      <View style={[style, { backgroundColor: '#f5f5f5', justifyContent: 'center', alignItems: 'center' }]}>
        <Text style={{ fontSize: 10, color: '#999', textAlign: 'center' }}>
          ⚠️
        </Text>
      </View>
    );
  }

  return (
    <View style={style}>
      {loading && (
        <View style={[StyleSheet.absoluteFillObject, { justifyContent: 'center', alignItems: 'center', backgroundColor: '#f8f8f8' }]}>
          <ActivityIndicator size="small" color="#ccc" />
        </View>
      )}
      <Image
        source={{ 
          uri: source.uri,
          cache: 'force-cache', // Force caching for better performance
        }}
        style={[style, { opacity: loading ? 0.5 : 1 }]}
        resizeMode={resizeMode}
        onLoad={handleLoad}
        onError={handleError}
        fadeDuration={50} // Faster fade for better mobile performance
        progressiveRenderingEnabled={true}
        defaultSource={undefined} // Avoid default source to prevent flicker
      />
    </View>
  );
});

OptimizedImage.displayName = 'OptimizedImage';

export function StickerGifPickerMobile({
  visible,
  onClose,
  onSelectSticker,
  onSelectGif,
}: StickerGifPickerMobileProps) {
  const { theme } = useTheme();
  const scrollViewRef = useRef<ScrollView>(null);
  
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

  // Convert Tenor result to Sticker format
  // Important: React Native Image has limited/varied WebP support on mobile builds.
  // To ensure stickers render on iOS/Android, prefer GIF variants on native and keep WebP on web for quality/alpha.
  const convertTenorToSticker = (result: TenorResult): Sticker => {
    const isWeb = Platform.OS === 'web';
    // Pick best URL per platform
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

    // Dimensions: fallback through available formats
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

  // Convert Tenor result to GIF format
  // Keep GIF URL for compatibility; use static thumbnail to avoid grid jank.
  const convertTenorToGif = (result: TenorResult): GifData => {
    const url =
      result.media_formats.gif?.url ||
      result.media_formats.mediumgif?.url ||
      result.media_formats.mp4?.url ||
      '';

    const thumbnailUrl =
      (typeof result.media_formats.preview === 'string' ? result.media_formats.preview : undefined) ||
      result.media_formats.nanowebp?.url ||
      result.media_formats.tinywebp?.url ||
      result.media_formats.webp?.url ||
      result.media_formats.nanogif?.url ||
      result.media_formats.tinygif?.url ||
      result.media_formats.gif?.url ||
      '';

    const dims =
      result.media_formats.nanogif?.dims ||
      result.media_formats.tinygif?.dims ||
      result.media_formats.gif?.dims ||
      result.media_formats.mp4?.dims ||
      [320, 180];

    return {
      id: result.id,
      url,
      thumbnailUrl,
      width: dims[0] || 320,
      height: dims[1] || 180,
      title: result.title || result.content_description || 'GIF',
      source: 'tenor',
    };
  };

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
  // Request Tenor sticker results with a basic media set to ensure GIF variants are available on native
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
  // Request a basic set that includes preview/webp for static thumbnails
  let url = `${TENOR_BASE_URL}/search?q=${encodeURIComponent(query)}&key=${TENOR_API_KEY}&limit=20&media_filter=basic`;
      
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

  // Handle load more for stickers
  const handleLoadMoreStickers = () => {
    if (hasMoreStickers && !isLoadingMore && !isLoadingStickers) {
      fetchStickers(searchQuery || undefined, true);
    }
  };

  // Handle load more for gifs
  const handleLoadMoreGifs = () => {
    if (hasMoreGifs && !isLoadingMore && !isLoadingGifs) {
      fetchGifs(searchQuery || undefined, true);
    }
  };

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

  // Styles
  const styles = useMemo(() => StyleSheet.create({
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
      marginTop: 4,
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
      paddingRight: 40,
    },
    searchIcon: {
      // Deprecated: kept for backward compatibility if referenced elsewhere
    },
    searchIconContainer: {
      position: 'absolute',
      right: 12,
      top: 0,
      bottom: 0,
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 1,
      // ensure enough tap-through area; icon isn't interactive
      width: 24,
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
      paddingHorizontal: 8,
      paddingVertical: 4,
      flexGrow: 1,
    },
    gridItem: {
      width: ITEM_SIZE,
      height: ITEM_SIZE,
      marginHorizontal: 2,
      marginVertical: 2,
      borderRadius: 8,
      overflow: 'hidden',
      backgroundColor: theme.background,
      justifyContent: 'center',
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.1,
      shadowRadius: 2,
      elevation: 2,
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
  }), [theme]);

  // Event handlers
  const handleStickerSelect = (sticker: Sticker) => {
    onSelectSticker(sticker);
    onClose();
  };

  const handleGifSelect = (gif: GifData) => {
    onSelectGif(gif);
    onClose();
  };

  // Render functions - optimized for mobile performance
  const renderStickerItem = ({ item, index }: { item: Sticker; index: number }) => (
    <TouchableOpacity
      style={styles.gridItem}
      onPress={() => handleStickerSelect(item)}
      activeOpacity={0.7}
    >
      <OptimizedImage
        source={{ uri: item.url }}
        style={{ width: '85%', height: '85%' }}
        resizeMode="contain"
      />
    </TouchableOpacity>
  );

  const renderGifItem = ({ item, index }: { item: GifData; index: number }) => (
    <TouchableOpacity
      style={[styles.gridItem, { height: ITEM_SIZE * 0.75 }]}
      onPress={() => handleGifSelect(item)}
      activeOpacity={0.7}
    >
      <OptimizedImage
        source={{ uri: item.thumbnailUrl }}
        style={{ width: '100%', height: '100%' }}
        resizeMode="cover"
      />
    </TouchableOpacity>
  );

  if (!visible) return null;

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
              style={[styles.tabText, activeTab === 'stickers' && styles.activeTabText]}
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
            <View style={[styles.searchIconContainer, { pointerEvents: 'none' }]}>
              <Search size={20} color={theme.textSecondary} />
            </View>
          </View>
        </View>

        {/* Content */}
        <View style={styles.content}>
          {activeTab === 'stickers' ? (
            <>
              {/* Sticker Categories */}
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

              {/* Stickers Grid */}
              {isLoadingStickers ? (
                <View style={styles.loadingContainer}>
                  <ActivityIndicator size="large" color={theme.primary} />
                  <Text style={styles.loadingText}>Loading stickers...</Text>
                </View>
              ) : (
                <FlatList
                  data={filteredStickers}
                  renderItem={renderStickerItem}
                  keyExtractor={(item) => item.id}
                  numColumns={NUM_COLUMNS}
                  key={NUM_COLUMNS} // Force re-render when columns change
                  contentContainerStyle={styles.grid}
                  columnWrapperStyle={NUM_COLUMNS > 1 ? { justifyContent: 'space-between', paddingHorizontal: 8 } : undefined}
                  showsVerticalScrollIndicator={false}
                  removeClippedSubviews={true}
                  maxToRenderPerBatch={NUM_COLUMNS * 2} // 2 rows at a time
                  windowSize={5} // Optimized for mobile
                  initialNumToRender={NUM_COLUMNS * 4} // 4 rows initially
                  updateCellsBatchingPeriod={200} // Slightly higher for better performance
                  onEndReached={handleLoadMoreStickers}
                  onEndReachedThreshold={0.3} // Higher threshold for more reliable triggering
                  getItemLayout={undefined} // Let FlatList calculate dynamically for better performance
                  ListFooterComponent={() => 
                    isLoadingMore ? (
                      <View style={styles.loadingMoreContainer}>
                        <ActivityIndicator size="small" color={theme.primary} />
                        <Text style={styles.loadingMoreText}>Loading more...</Text>
                      </View>
                    ) : null
                  }
                  ListEmptyComponent={() => (
                    <View style={styles.emptyContainer}>
                      <Text style={styles.emptyText}>
                        {searchQuery
                          ? `No stickers found for "${searchQuery}"`
                          : 'No stickers available'}
                      </Text>
                    </View>
                  )}
                />
              )}
            </>
          ) : (
            /* GIFs Grid */
            isLoadingGifs ? (
              <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={theme.primary} />
                <Text style={styles.loadingText}>Loading GIFs...</Text>
              </View>
            ) : (
              <FlatList
                data={filteredGifs}
                renderItem={renderGifItem}
                keyExtractor={(item) => item.id}
                numColumns={NUM_COLUMNS}
                key={`gifs-${NUM_COLUMNS}`} // Force re-render when columns change
                contentContainerStyle={styles.grid}
                columnWrapperStyle={NUM_COLUMNS > 1 ? { justifyContent: 'space-between', paddingHorizontal: 8 } : undefined}
                showsVerticalScrollIndicator={false}
                removeClippedSubviews={true}
                maxToRenderPerBatch={NUM_COLUMNS * 2} // 2 rows at a time
                windowSize={5} // Optimized for mobile
                initialNumToRender={NUM_COLUMNS * 4} // 4 rows initially
                updateCellsBatchingPeriod={200} // Slightly higher for better performance
                onEndReached={handleLoadMoreGifs}
                onEndReachedThreshold={0.3} // Higher threshold for more reliable triggering
                getItemLayout={undefined} // Let FlatList calculate dynamically for better performance
                ListFooterComponent={() => 
                  isLoadingMore ? (
                    <View style={styles.loadingMoreContainer}>
                      <ActivityIndicator size="small" color={theme.primary} />
                      <Text style={styles.loadingMoreText}>Loading more...</Text>
                    </View>
                  ) : null
                }
                ListEmptyComponent={() => (
                  <View style={styles.emptyContainer}>
                    <Text style={styles.emptyText}>
                      {searchQuery
                        ? `No GIFs found for "${searchQuery}"`
                        : 'No GIFs available'}
                    </Text>
                  </View>
                )}
              />
            )
          )}
        </View>
      </View>
    </View>
  );
}
