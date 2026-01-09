import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Modal,
  Pressable,
  Dimensions,
  Platform,
  ScrollView,
  TextInput,
  StyleSheet,
  FlatList,
} from 'react-native';
import { X, Search, Clipboard as ClipboardIcon, Check } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';

type QuickActionVariant = 'default' | 'primary' | 'danger';

interface QuickActionConfig {
  label: string;
  onPress: () => void;
  icon?: React.ReactNode;
  variant?: QuickActionVariant;
  disabled?: boolean;
}

interface EnhancedEmojiPickerProps {
  visible: boolean;
  onClose: () => void;
  onEmojiSelect: (emoji: string) => void;
  position?: { x: number; y: number };
  selectedMessageId?: string | null;
  getReactionStatus?: (messageId: string, emoji: string) => { count: number; hasUserReacted: boolean };
  theme: {
    background: string;
    surface: string;
    border: string;
    text: string;
    textSecondary: string;
    primary: string;
  };
  // Optional: if provided, shows a Copy button in Quick Reactions for text messages
  copyText?: string;
  extraActions?: QuickActionConfig[];
}

const EnhancedEmojiPicker: React.FC<EnhancedEmojiPickerProps> = ({
  visible,
  onClose,
  onEmojiSelect,
  position = { x: 0, y: 0 },
  selectedMessageId,
  getReactionStatus,
  theme,
  copyText,
  extraActions = [],
}) => {
  const [showFullPicker, setShowFullPicker] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [copied, setCopied] = useState(false);
  
  // Quick reactions in 2 rows for better visibility
  const quickReactions = [
    // Row 1
    ['❤️', '😂', '😍', '😭', '😡', '😢', '😮', '😱'],
    // Row 2  
    ['👍', '👎', '😀', '💯', '🔥', '✨', '🎉', '👏']
  ];
  
  // Comprehensive emoji database with search keywords
  const emojiDatabase = useMemo(() => [
    // Smileys & Emotion
    { emoji: '😀', keywords: ['grinning', 'happy', 'smile', 'face', 'joy'] },
    { emoji: '😃', keywords: ['smiley', 'happy', 'joy', 'face', 'glad'] },
    { emoji: '😄', keywords: ['smile', 'happy', 'joy', 'laugh', 'pleased'] },
    { emoji: '😁', keywords: ['grin', 'happy', 'smile', 'joy', 'cheerful'] },
    { emoji: '😆', keywords: ['laugh', 'happy', 'joy', 'lol', 'satisfied'] },
    { emoji: '😅', keywords: ['sweat', 'smile', 'happy', 'laugh', 'nervous'] },
    { emoji: '🤣', keywords: ['rofl', 'laugh', 'crying', 'lol', 'joy'] },
    { emoji: '😂', keywords: ['joy', 'laugh', 'cry', 'happy', 'tears'] },
    { emoji: '🙂', keywords: ['smile', 'happy', 'faint', 'positive', 'slight'] },
    { emoji: '🙃', keywords: ['upside', 'down', 'smile', 'sarcasm', 'silly'] },
    { emoji: '😉', keywords: ['wink', 'smile', 'flirt', 'playful', 'tease'] },
    { emoji: '😊', keywords: ['blush', 'smile', 'happy', 'flushed', 'crush'] },
    { emoji: '😇', keywords: ['angel', 'innocent', 'pure', 'blessed', 'halo'] },
    { emoji: '🥰', keywords: ['love', 'smile', 'heart', 'affection', 'crush'] },
    { emoji: '😍', keywords: ['heart', 'eyes', 'love', 'crush', 'adore'] },
    { emoji: '🤩', keywords: ['star', 'eyes', 'excited', 'wow', 'amazed'] },
    { emoji: '😘', keywords: ['kiss', 'love', 'like', 'affection', 'muah'] },
    { emoji: '😗', keywords: ['kiss', 'smile', 'pucker', 'love', 'cute'] },
    { emoji: '☺️', keywords: ['smile', 'happy', 'content', 'pleased', 'blush'] },
    { emoji: '😚', keywords: ['kiss', 'smile', 'affection', 'love', 'cute'] },
    { emoji: '😙', keywords: ['kiss', 'affection', 'love', 'like', 'smooch'] },
    { emoji: '🥲', keywords: ['happy', 'cry', 'tear', 'proud', 'grateful'] },
    { emoji: '😋', keywords: ['tongue', 'lick', 'taste', 'delicious', 'yum'] },
    { emoji: '😛', keywords: ['tongue', 'silly', 'playful', 'crazy', 'tease'] },
    { emoji: '😜', keywords: ['tongue', 'wink', 'silly', 'crazy', 'playful'] },
    { emoji: '🤪', keywords: ['zany', 'goofy', 'wacky', 'crazy', 'silly'] },
    { emoji: '😝', keywords: ['tongue', 'prank', 'silly', 'playful', 'tease'] },
    { emoji: '🤑', keywords: ['money', 'rich', 'dollar', 'cash', 'greedy'] },
    { emoji: '🤗', keywords: ['hug', 'smile', 'happy', 'cuddle', 'embrace'] },
    { emoji: '🤭', keywords: ['oops', 'smile', 'secret', 'shy', 'giggle'] },
    { emoji: '🤫', keywords: ['shh', 'quiet', 'silence', 'secret', 'whisper'] },
    { emoji: '🤔', keywords: ['think', 'confused', 'hmm', 'consider', 'curious'] },
    { emoji: '🤐', keywords: ['zipper', 'mouth', 'quiet', 'secret', 'silence'] },
    { emoji: '🤨', keywords: ['eyebrow', 'suspicious', 'skeptical', 'hmm', 'doubt'] },
    { emoji: '😐', keywords: ['neutral', 'meh', 'straight', 'deadpan', 'blank'] },
    { emoji: '😑', keywords: ['expressionless', 'meh', 'blank', 'deadpan', 'boring'] },
    { emoji: '😶', keywords: ['silence', 'quiet', 'blank', 'speechless', 'mute'] },
    { emoji: '😏', keywords: ['smirk', 'smile', 'mean', 'prank', 'devil'] },
    { emoji: '😒', keywords: ['unamused', 'meh', 'bored', 'straight', 'serious'] },
    { emoji: '🙄', keywords: ['eye', 'roll', 'frustrated', 'sarcasm', 'whatever'] },
    { emoji: '😬', keywords: ['grimace', 'teeth', 'nervous', 'awkward', 'yikes'] },
    { emoji: '🤥', keywords: ['liar', 'pinocchio', 'nose', 'lie', 'dishonest'] },
    
    // Sad & Negative
    { emoji: '😔', keywords: ['sad', 'down', 'unhappy', 'depressed', 'sorry'] },
    { emoji: '😕', keywords: ['sad', 'confused', 'sorry', 'frown', 'disappointed'] },
    { emoji: '🙁', keywords: ['sad', 'frown', 'unhappy', 'sorry', 'disappointed'] },
    { emoji: '☹️', keywords: ['sad', 'frown', 'unhappy', 'sorry', 'upset'] },
    { emoji: '😣', keywords: ['sad', 'tired', 'upset', 'stressed', 'struggle'] },
    { emoji: '😖', keywords: ['sad', 'tired', 'upset', 'confused', 'frustrated'] },
    { emoji: '😫', keywords: ['tired', 'fed', 'up', 'exhausted', 'done'] },
    { emoji: '😩', keywords: ['tired', 'stressed', 'sad', 'weary', 'frustrated'] },
    { emoji: '🥺', keywords: ['puppy', 'dog', 'eyes', 'sad', 'pleading'] },
    { emoji: '😢', keywords: ['cry', 'sad', 'tear', 'sorry', 'emotional'] },
    { emoji: '😭', keywords: ['cry', 'sob', 'sad', 'upset', 'tears'] },
    { emoji: '😤', keywords: ['angry', 'mad', 'hate', 'despise', 'steaming'] },
    { emoji: '😠', keywords: ['angry', 'mad', 'annoyed', 'frustrated', 'upset'] },
    { emoji: '😡', keywords: ['angry', 'mad', 'hate', 'annoyed', 'furious'] },
    { emoji: '🤬', keywords: ['swearing', 'cursing', 'angry', 'mad', 'symbols'] },
    { emoji: '🤯', keywords: ['mind', 'blown', 'shocked', 'amazed', 'wow'] },
    
    // Heart & Love
    { emoji: '❤️', keywords: ['love', 'heart', 'like', 'affection', 'red'] },
    { emoji: '🧡', keywords: ['orange', 'heart', 'love', 'like', 'affection'] },
    { emoji: '💛', keywords: ['yellow', 'heart', 'love', 'like', 'affection'] },
    { emoji: '💚', keywords: ['green', 'heart', 'love', 'like', 'nature'] },
    { emoji: '💙', keywords: ['blue', 'heart', 'love', 'like', 'trust'] },
    { emoji: '💜', keywords: ['purple', 'heart', 'love', 'like', 'affection'] },
    { emoji: '🖤', keywords: ['black', 'heart', 'evil', 'wicked', 'dark'] },
    { emoji: '🤍', keywords: ['white', 'heart', 'pure', 'clean', 'innocent'] },
    { emoji: '🤎', keywords: ['brown', 'heart', 'love', 'like', 'earth'] },
    { emoji: '💔', keywords: ['broken', 'heart', 'sad', 'sorry', 'break'] },
    { emoji: '❣️', keywords: ['exclamation', 'heart', 'love', 'like', 'affection'] },
    { emoji: '💕', keywords: ['two', 'hearts', 'love', 'like', 'affection'] },
    { emoji: '💞', keywords: ['revolving', 'hearts', 'love', 'like', 'affection'] },
    { emoji: '💓', keywords: ['beating', 'heart', 'love', 'like', 'affection'] },
    { emoji: '💗', keywords: ['growing', 'heart', 'love', 'like', 'affection'] },
    { emoji: '💖', keywords: ['sparkling', 'heart', 'love', 'like', 'affection'] },
    { emoji: '💘', keywords: ['cupid', 'heart', 'love', 'like', 'affection'] },
    { emoji: '💝', keywords: ['gift', 'heart', 'love', 'like', 'affection'] },
    
    // Gestures & Body
    { emoji: '👍', keywords: ['thumbs', 'up', 'yes', 'awesome', 'good'] },
    { emoji: '👎', keywords: ['thumbs', 'down', 'no', 'bad', 'hate'] },
    { emoji: '👌', keywords: ['ok', 'hand', 'fingers', 'perfect', 'good'] },
    { emoji: '🤌', keywords: ['pinched', 'fingers', 'italian', 'chef', 'kiss'] },
    { emoji: '🤏', keywords: ['pinching', 'hand', 'small', 'tiny', 'little'] },
    { emoji: '✌️', keywords: ['peace', 'fingers', 'hand', 'hi', 'two'] },
    { emoji: '🤞', keywords: ['crossed', 'fingers', 'luck', 'hope', 'wish'] },
    { emoji: '🤟', keywords: ['love', 'you', 'hand', 'fingers', 'ily'] },
    { emoji: '🤘', keywords: ['rock', 'on', 'hand', 'fingers', 'horns'] },
    { emoji: '🤙', keywords: ['call', 'me', 'hand', 'shaka', 'hang'] },
    { emoji: '👈', keywords: ['point', 'left', 'finger', 'hand', 'direction'] },
    { emoji: '👉', keywords: ['point', 'right', 'finger', 'hand', 'direction'] },
    { emoji: '👆', keywords: ['point', 'up', 'finger', 'hand', 'direction'] },
    { emoji: '🖕', keywords: ['middle', 'finger', 'hand', 'rude', 'bad'] },
    { emoji: '👇', keywords: ['point', 'down', 'finger', 'hand', 'direction'] },
    { emoji: '☝️', keywords: ['point', 'up', 'finger', 'hand', 'direction'] },
    { emoji: '👋', keywords: ['wave', 'hand', 'fingers', 'goodbye', 'hello'] },
    { emoji: '🤚', keywords: ['raised', 'back', 'hand', 'fingers', 'stop'] },
    { emoji: '🖐️', keywords: ['hand', 'fingers', 'stop', 'raised', 'five'] },
    { emoji: '✋', keywords: ['hand', 'fingers', 'stop', 'raised', 'five'] },
    { emoji: '🖖', keywords: ['spock', 'hand', 'fingers', 'vulcan', 'star'] },
    { emoji: '🙏', keywords: ['please', 'hope', 'wish', 'namaste', 'highfive'] },
    
    // Activities & Objects
    { emoji: '🔥', keywords: ['fire', 'flame', 'hot', 'burn', 'lit'] },
    { emoji: '💯', keywords: ['hundred', 'perfect', 'score', 'great', 'awesome'] },
    { emoji: '💥', keywords: ['boom', 'explode', 'explosion', 'collision', 'comic'] },
    { emoji: '💫', keywords: ['dizzy', 'star', 'sparkle', 'shine', 'magic'] },
    { emoji: '💦', keywords: ['water', 'drops', 'sweat', 'splash', 'rain'] },
    { emoji: '💨', keywords: ['wind', 'blow', 'fast', 'speed', 'air'] },
    { emoji: '⭐', keywords: ['star', 'night', 'yellow', 'favorite', 'rating'] },
    { emoji: '🌟', keywords: ['glowing', 'star', 'sparkle', 'awesome', 'amazing'] },
    { emoji: '✨', keywords: ['sparkles', 'stars', 'shine', 'magic', 'clean'] },
    { emoji: '⚡', keywords: ['lightning', 'thunder', 'electric', 'fast', 'zap'] },
    { emoji: '☄️', keywords: ['comet', 'space', 'shooting', 'star', 'fast'] },
    { emoji: '💎', keywords: ['diamond', 'gem', 'jewel', 'expensive', 'precious'] },
    { emoji: '🔔', keywords: ['bell', 'sound', 'notification', 'ring', 'church'] },
    { emoji: '🔕', keywords: ['bell', 'sound', 'volume', 'mute', 'quiet'] },
    { emoji: '🎉', keywords: ['party', 'celebration', 'birthday', 'event', 'tada'] },
    { emoji: '🎊', keywords: ['party', 'celebration', 'birthday', 'confetti', 'event'] },
    { emoji: '🎁', keywords: ['gift', 'present', 'birthday', 'christmas', 'box'] },
    { emoji: '🎈', keywords: ['balloon', 'party', 'celebration', 'birthday', 'float'] },
  ], []);
  
  // Filter emojis based on search query
  const filteredEmojis = useMemo(() => {
    if (!searchQuery.trim()) return emojiDatabase;
    
    const query = searchQuery.toLowerCase().trim();
    return emojiDatabase.filter(item => 
      item.keywords.some(keyword => keyword.includes(query)) ||
      item.emoji.includes(query)
    );
  }, [searchQuery, emojiDatabase]);
  
  const screenWidth = Dimensions.get('window').width;
  const screenHeight = Dimensions.get('window').height;
  const hasQuickActions = extraActions.length > 0;
  
  // Calculate position for the picker
  const pickerWidth = 340;
  const pickerHeight = showFullPicker ? 420 : hasQuickActions ? 228 : 180;
  
  const calculatedPosition = {
    top: Math.max(50, Math.min(position.y - pickerHeight / 2, screenHeight - pickerHeight - 50)),
    left: Math.max(20, Math.min(position.x - pickerWidth / 2, screenWidth - pickerWidth - 20)),
  };

  // Reset state when picker closes
  useEffect(() => {
    if (!visible) {
      setShowFullPicker(false);
      setSearchQuery('');
    }
  }, [visible]);

  const handleEmojiSelect = (emoji: string) => {
    onEmojiSelect(emoji);
    onClose();
  };

  const handleCopy = async () => {
    if (!copyText || !copyText.trim()) return;
    try {
      await Clipboard.setStringAsync(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  const renderQuickReactions = () => {
    return (
      <View style={[styles.quickReactionsContainer, { position: 'relative' }]}>
        <Text style={[styles.pickerTitle, { color: theme.text }]}>
          Quick Reactions
        </Text>
        
        {/* Render 2 rows of quick reactions */}
        {quickReactions.map((row, rowIndex) => (
          <ScrollView 
            key={rowIndex}
            horizontal 
            showsHorizontalScrollIndicator={false}
            style={styles.quickReactionsScroll}
            contentContainerStyle={styles.quickReactionsContent}
          >
            {row.map((emoji, index) => {
              const reactionStatus = selectedMessageId && getReactionStatus ? 
                getReactionStatus(selectedMessageId, emoji) : { count: 0, hasUserReacted: false };
              
              return (
                <TouchableOpacity
                  key={`${rowIndex}-${index}`}
                  style={styles.emojiButton}
                  onPress={() => handleEmojiSelect(emoji)}
                >
                  <Text style={styles.emojiText}>{emoji}</Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        ))}

        {hasQuickActions && (
          <View style={styles.quickActionsRow}>
            {extraActions.map((action, index) => {
              const variant: QuickActionVariant = action.variant || 'default';
              const isDisabled = action.disabled;
              const baseStyle = [
                styles.quickActionButton,
                variant === 'primary' && { backgroundColor: theme.primary },
                variant === 'danger' && { backgroundColor: '#ef4444' },
                variant === 'default' && { backgroundColor: theme.background, borderColor: theme.border, borderWidth: 1 },
                isDisabled && styles.quickActionButtonDisabled,
              ];

              const textStyle = [
                styles.quickActionText,
                variant === 'default' && { color: theme.text },
              ];

              return (
                <TouchableOpacity
                  key={`${action.label}-${index}`}
                  style={baseStyle}
                  onPress={() => {
                    if (!isDisabled) {
                      action.onPress();
                    }
                  }}
                  disabled={isDisabled}
                  accessibilityRole="button"
                >
                  {action.icon}
                  <Text style={textStyle}>{action.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
        
        <View style={styles.footerRow}>
          <TouchableOpacity 
            style={[styles.moreEmojisButton, { backgroundColor: theme.primary, flex: 1 }]}
            onPress={() => setShowFullPicker(true)}
          >
            <Text style={styles.moreEmojisText}>More Emojis</Text>
          </TouchableOpacity>
          {copyText && copyText.trim().length > 0 && (
            <TouchableOpacity
              accessibilityLabel="Copy text"
              style={[styles.copyIconButton, { backgroundColor: theme.primary }]}
              onPress={handleCopy}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
            >
              {copied ? (
                <Check size={18} color="#ffffff" />
              ) : (
                <ClipboardIcon size={18} color="#ffffff" />
              )}
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  const renderFullPicker = () => (
    <View style={styles.fullPickerContainer}>
      <View style={styles.fullPickerHeader}>
        <Text style={[styles.pickerTitle, { color: theme.text }]}>
          Choose an Emoji
        </Text>
        <TouchableOpacity 
          style={[styles.backButton, { backgroundColor: theme.background }]}
          onPress={() => setShowFullPicker(false)}
        >
          <X size={18} color={theme.textSecondary} />
        </TouchableOpacity>
      </View>
      
      {/* Search functionality */}
      <Pressable 
        style={[styles.searchContainer, { backgroundColor: theme.background, borderColor: theme.border }]}
        onPress={(e) => e.stopPropagation()} // Prevent modal close when touching search area
      >
        <Search size={16} color={theme.textSecondary} />
        <TextInput
          style={[styles.searchInput, { color: theme.text }]}
          placeholder="Search emojis..."
          placeholderTextColor={theme.textSecondary}
          value={searchQuery}
          onChangeText={setSearchQuery}
          autoCapitalize="none"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <X size={16} color={theme.textSecondary} />
          </TouchableOpacity>
        )}
      </Pressable>
      
      {/* Search Results or All Emojis */}
      <View style={styles.emojiListContainer}>
        {filteredEmojis.length > 0 ? (
          <FlatList
            data={filteredEmojis}
            numColumns={8}
            key="emojiGrid" // Force re-render when columns change
            showsVerticalScrollIndicator={false}
            keyExtractor={(item, index) => `${item.emoji}-${index}`}
            renderItem={({ item }) => {
              const reactionStatus = selectedMessageId && getReactionStatus ? 
                getReactionStatus(selectedMessageId, item.emoji) : { count: 0, hasUserReacted: false };
              
              return (
                <TouchableOpacity
                  style={[
                    styles.emojiGridButton,
                    reactionStatus.hasUserReacted && [styles.selectedEmojiGridButton, { borderColor: theme.primary }]
                  ]}
                  onPress={() => handleEmojiSelect(item.emoji)}
                >
                  <Text style={styles.emojiGridText}>{item.emoji}</Text>
                </TouchableOpacity>
              );
            }}
            contentContainerStyle={styles.emojiGridContainer}
          />
        ) : (
          <View style={styles.noResultsContainer}>
            <Text style={[styles.noResultsText, { color: theme.textSecondary }]}>
              {`No emojis found for "${searchQuery}"`}
            </Text>
            <Text style={[styles.noResultsSubtext, { color: theme.textSecondary }]}>
              {`Try searching for "happy", "love", "fire", etc.`}
            </Text>
          </View>
        )}
      </View>
    </View>
  );

  if (!visible) return null;

  return (
    <Modal
      transparent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable 
          style={[
            styles.pickerContainer,
            { 
              backgroundColor: theme.surface,
              borderColor: theme.border,
              width: pickerWidth,
              height: pickerHeight,
              ...calculatedPosition,
            }
          ]}
          onPress={(e) => e.stopPropagation()} // Prevent closing when clicking inside
        >
          {showFullPicker ? renderFullPicker() : renderQuickReactions()}
          
          {/* Close button */}
          <TouchableOpacity 
            style={[styles.closeButton, { backgroundColor: theme.background }]}
            onPress={onClose}
          >
            <X size={20} color={theme.textSecondary} />
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  pickerContainer: {
    position: 'absolute',
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 8,
  },
  
  copyRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginBottom: 8,
  },
  copyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: 'flex-end',
  },
  copyButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
  quickReactionsContainer: {
    flex: 1,
  },
  pickerTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 12,
    textAlign: 'center',
  },
  quickReactionsScroll: {
    maxHeight: 60,
    marginBottom: 4, // Add spacing between rows
  },
  quickReactionsContent: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
  },
  emojiGrid: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 4,
  },
  emojiButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
    marginHorizontal: 2,
  },
  emojiText: {
    fontSize: 24,
    lineHeight: 28,
  },
  emojiCount: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  emojiCountText: {
    color: 'white',
    fontSize: 10,
    fontWeight: '600',
  },
  moreEmojisButton: {
    marginTop: 12,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  moreEmojisText: {
    color: 'white',
    fontSize: 14,
    fontWeight: '600',
  },
  quickActionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
    justifyContent: 'center',
  },
  quickActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 999,
    gap: 6,
  },
  quickActionButtonDisabled: {
    opacity: 0.6,
  },
  quickActionText: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  copyIconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  marginTop: 8,
  },
  fullPickerContainer: {
    flex: 1,
  },
  fullPickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  backButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 12,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
  },
  emojiSelectorContainer: {
    flex: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  emojiListContainer: {
    flex: 1,
    paddingTop: 8,
  },
  emojiGridContainer: {
    paddingBottom: 16,
  },
  emojiGridButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderWidth: 2,
    borderColor: 'transparent',
    margin: 2,
  },
  selectedEmojiGridButton: {
    borderWidth: 2,
    backgroundColor: 'rgba(139, 92, 246, 0.1)',
  },
  emojiGridText: {
    fontSize: 22,
    lineHeight: 26,
  },
  emojiGridCount: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  emojiGridCountText: {
    color: 'white',
    fontSize: 9,
    fontWeight: '600',
  },
  noResultsContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 32,
  },
  noResultsText: {
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
    marginBottom: 8,
  },
  noResultsSubtext: {
    fontSize: 14,
    textAlign: 'center',
    fontStyle: 'italic',
  },
  closeButton: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default EnhancedEmojiPicker;
