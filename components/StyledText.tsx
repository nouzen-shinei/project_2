import { logger } from '@/lib/logger';
import React from 'react';
import { Text, Linking, Alert, StyleSheet, Platform } from 'react-native';
import { splitChatTextForHighlight } from '../lib/chatSearchHighlight';

/**
 * StyledText component that supports markdown-like formatting:
 * - ***extra bold*** - Extra bold formatting
 * - **bold text** - Bold formatting
 * - *italic text* - Italic formatting  
 * - __underline text__ - Underlined text
 * - ~~strikethrough~~ - Strikethrough text
 * - `code text` - Monospace/code formatting
 * - /special text - Special message formatting
 * - URLs, emails, phones, etc. - Clickable links (from LinkifiedText)
 */

interface StyledTextProps {
  text: string;
  style?: any;
  linkStyle?: any;
  highlightQuery?: string;
  highlightStyle?: any;
}

interface TextSegment {
  type: 'text' | 'extrabold' | 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'special' | 'url' | 'email' | 'phone' | 'location' | 'youtube' | 'mention' | 'hashtag' | 'coordinates' | 'stock' | 'date' | 'file' | 'ip' | 'github' | 'zoom';
  text: string;
  url?: string;
  styles?: any[];
}

export default function StyledText({
  text,
  style,
  linkStyle,
  highlightQuery,
  highlightStyle,
}: StyledTextProps) {
  // Regular expressions for different formatting
  const extraBoldRegex = /\*\*\*(.*?)\*\*\*/g;
  const boldRegex = /\*\*(.*?)\*\*/g;
  const italicRegex = /\*(.*?)\*/g;
  const underlineRegex = /__(.*?)__/g;
  const strikethroughRegex = /~~(.*?)~~/g;
  const codeRegex = /`(.*?)`/g;
  const specialRegex = /\/special\s+(.*?)(?=\s|$)/g;

  // Link detection regexes (from LinkifiedText)
  const urlRegex = /https?:\/\/[^\s]+|www\.[^\s]+/gi;
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const phoneRegex = /(\+\d{1,3}[-.\s]?)?([(]?\d{3}[)]?[-.\s]?)?\d{3}[-.\s]?\d{4}|\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\+\d{1,3}[-.\s]?\d{5,15}/gi;
  const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/gi;
  const mentionRegex = /@[a-zA-Z0-9_]+/gi;
  const hashtagRegex = /#[a-zA-Z0-9_]+/gi;

  const parseText = (inputText: string): TextSegment[] => {
    const segments: TextSegment[] = [];
    const allMatches: {
      start: number;
      end: number;
      type: TextSegment['type'];
      text: string;
      replacement: string;
      url?: string;
    }[] = [];

    // Find all formatting matches
    let match;

    // Extra bold text ***text*** (must be checked before bold)
    while ((match = extraBoldRegex.exec(inputText)) !== null) {
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'extrabold',
        text: match[0],
        replacement: match[1]
      });
    }
    extraBoldRegex.lastIndex = 0;

    // Bold text **text**
    while ((match = boldRegex.exec(inputText)) !== null) {
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'bold',
        text: match[0],
        replacement: match[1]
      });
    }
    boldRegex.lastIndex = 0;

    // Italic text *text* (but not if it's already part of bold **text** or extra bold ***text***)
    while ((match = italicRegex.exec(inputText)) !== null) {
      // Check if this asterisk is part of a bold or extra bold pattern
      const beforeChar = match.index > 0 ? inputText[match.index - 1] : '';
      const afterChar = match.index + match[0].length < inputText.length ? 
        inputText[match.index + match[0].length] : '';
      const beforeChar2 = match.index > 1 ? inputText[match.index - 2] : '';
      const afterChar2 = match.index + match[0].length + 1 < inputText.length ? 
        inputText[match.index + match[0].length + 1] : '';
      
      // Skip if this is part of a bold pattern (**text**) or extra bold pattern (***text***)
      if (beforeChar !== '*' && afterChar !== '*' && beforeChar2 !== '*' && afterChar2 !== '*') {
        allMatches.push({
          start: match.index,
          end: match.index + match[0].length,
          type: 'italic',
          text: match[0],
          replacement: match[1]
        });
      }
    }
    italicRegex.lastIndex = 0;

    // Underline __text__
    while ((match = underlineRegex.exec(inputText)) !== null) {
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'underline',
        text: match[0],
        replacement: match[1]
      });
    }
    underlineRegex.lastIndex = 0;

    // Strikethrough ~~text~~
    while ((match = strikethroughRegex.exec(inputText)) !== null) {
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'strikethrough',
        text: match[0],
        replacement: match[1]
      });
    }
    strikethroughRegex.lastIndex = 0;

    // Code `text`
    while ((match = codeRegex.exec(inputText)) !== null) {
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'code',
        text: match[0],
        replacement: match[1]
      });
    }
    codeRegex.lastIndex = 0;

    // Special command /special text
    while ((match = specialRegex.exec(inputText)) !== null) {
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'special',
        text: match[0],
        replacement: match[1]
      });
    }
    specialRegex.lastIndex = 0;

    // URLs
    while ((match = urlRegex.exec(inputText)) !== null) {
      const url = match[0];
      if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
        let finalUrl = url;
        if (!finalUrl.startsWith('http')) {
          finalUrl = 'https://' + finalUrl;
        }
        allMatches.push({
          start: match.index,
          end: match.index + match[0].length,
          type: 'url',
          text: match[0],
          replacement: match[0],
          url: finalUrl
        });
      }
    }
    urlRegex.lastIndex = 0;

    // YouTube links
    while ((match = youtubeRegex.exec(inputText)) !== null) {
      const fullMatch = match[0];
      const videoId = match[1];
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'youtube',
        text: fullMatch,
        replacement: fullMatch,
        url: `https://www.youtube.com/watch?v=${videoId}`
      });
    }
    youtubeRegex.lastIndex = 0;

    // Emails
    while ((match = emailRegex.exec(inputText)) !== null) {
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'email',
        text: match[0],
        replacement: match[0],
        url: `mailto:${match[0]}`
      });
    }
    emailRegex.lastIndex = 0;

    // Phone numbers
    while ((match = phoneRegex.exec(inputText)) !== null) {
      const phoneText = match[0];
      const digitsOnly = phoneText.replace(/\D/g, '');
      
      if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
        allMatches.push({
          start: match.index,
          end: match.index + match[0].length,
          type: 'phone',
          text: phoneText,
          replacement: phoneText,
          url: `tel:${digitsOnly}`
        });
      }
    }
    phoneRegex.lastIndex = 0;

    // Mentions
    while ((match = mentionRegex.exec(inputText)) !== null) {
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'mention',
        text: match[0],
        replacement: match[0]
      });
    }
    mentionRegex.lastIndex = 0;

    // Hashtags
    while ((match = hashtagRegex.exec(inputText)) !== null) {
      allMatches.push({
        start: match.index,
        end: match.index + match[0].length,
        type: 'hashtag',
        text: match[0],
        replacement: match[0]
      });
    }
    hashtagRegex.lastIndex = 0;

    // Sort matches by start position
    allMatches.sort((a, b) => a.start - b.start);

    // Remove overlapping matches (keep the first one)
    const nonOverlappingMatches: {
      start: number;
      end: number;
      type: TextSegment['type'];
      text: string;
      replacement: string;
      url?: string;
    }[] = [];
    for (const match of allMatches) {
      const isOverlapping = nonOverlappingMatches.some(existing => 
        (match.start >= existing.start && match.start < existing.end) ||
        (match.end > existing.start && match.end <= existing.end) ||
        (match.start <= existing.start && match.end >= existing.end)
      );
      
      if (!isOverlapping) {
        nonOverlappingMatches.push(match);
      }
    }

    // Build segments
    let currentIndex = 0;
    
    for (const match of nonOverlappingMatches) {
      // Add text before this match
      if (match.start > currentIndex) {
        const beforeText = inputText.substring(currentIndex, match.start);
        // Filter out empty strings, whitespace-only strings, and single periods
        if (beforeText && beforeText.trim() && beforeText.trim() !== '.') {
          segments.push({
            type: 'text',
            text: beforeText
          });
        }
      }

      // Add the formatted segment
      // Filter out empty replacements and single periods
      if (match.replacement && match.replacement.trim() && match.replacement.trim() !== '.') {
        segments.push({
          type: match.type,
          text: match.replacement,
          url: match.url
        });
      }

      currentIndex = match.end;
    }

    // Add remaining text
    if (currentIndex < inputText.length) {
      const remainingText = inputText.substring(currentIndex);
      // Filter out empty strings, whitespace-only strings, and single periods
      if (remainingText && remainingText.trim() && remainingText.trim() !== '.') {
        segments.push({
          type: 'text',
          text: remainingText
        });
      }
    }

    return segments;
  };

  const handleLinkPress = async (url: string, type: string) => {
    try {
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      } else {
        Alert.alert('Error', `Cannot open ${type}. Please check if you have the appropriate app installed.`);
      }
    } catch (error) {
      logger.error('Error opening link:', error);
      Alert.alert('Error', `Failed to open ${type}.`);
    }
  };

  const renderSegment = (segment: TextSegment, index: number) => {
    const baseStyle = [style];
    const isClickable = segment.url || segment.type === 'mention' || segment.type === 'hashtag';

    // Apply formatting styles
    switch (segment.type) {
      case 'extrabold':
        baseStyle.push(styles.extrabold);
        break;
      case 'bold':
        baseStyle.push(styles.bold);
        break;
      case 'italic':
        baseStyle.push(styles.italic);
        break;
      case 'underline':
        baseStyle.push(styles.underline);
        break;
      case 'strikethrough':
        baseStyle.push(styles.strikethrough);
        break;
      case 'code':
        baseStyle.push(styles.code);
        break;
      case 'special':
        baseStyle.push(styles.special);
        break;
      case 'url':
      case 'email':
      case 'phone':
      case 'youtube':
        baseStyle.push(linkStyle || styles.link);
        break;
      case 'mention':
        baseStyle.push(styles.mention);
        break;
      case 'hashtag':
        baseStyle.push(styles.hashtag);
        break;
    }

    const handlePress = () => {
      if (segment.url) {
        handleLinkPress(segment.url, segment.type);
      } else if (segment.type === 'mention') {
        Alert.alert('Mention', `Tapped on ${segment.text}`);
      } else if (segment.type === 'hashtag') {
        Alert.alert('Hashtag', `Tapped on ${segment.text}`);
      }
    };

    return (
      <Text
        key={index}
        style={baseStyle}
        onPress={isClickable ? handlePress : undefined}
        suppressHighlighting
      >
        {splitChatTextForHighlight(segment.text, highlightQuery).map((part, partIndex) => (
          <Text
            key={`${index}:${partIndex}`}
            style={part.highlighted ? [styles.searchHighlight, highlightStyle] : undefined}
            suppressHighlighting
          >
            {part.text}
          </Text>
        ))}
      </Text>
    );
  };

  const mergeSegments = (input: TextSegment[]): TextSegment[] => {
    const merged: TextSegment[] = [];
    input.forEach((segment) => {
      if (merged.length > 0) {
        const last = merged[merged.length - 1];
        const isPhoneContinuation =
          last.type === 'phone' &&
          segment.type === 'text' &&
          /^[\d\s()+-]+$/.test(segment.text || '');

        if (isPhoneContinuation) {
          const combinedText = `${last.text}${segment.text}`;
          const normalizedDigits = combinedText.replace(/[^\d+]/g, '');
          merged[merged.length - 1] = {
            ...last,
            text: combinedText,
            url: `tel:${normalizedDigits}`,
          };
          return;
        }
      }

      merged.push(segment);
    });
    return merged;
  };

  const segments = mergeSegments(parseText(text));

  return (
    <Text style={style}>
      {segments.map((segment, index) => renderSegment(segment, index))}
    </Text>
  );
}

const styles = StyleSheet.create({
  extrabold: {
    fontWeight: '900',
    fontSize: 16,
    color: '#000000',
    ...(Platform.OS === 'web'
      ? { textShadow: '0.5px 0.5px 1px rgba(0, 0, 0, 0.3)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.3)',
          textShadowOffset: { width: 0.5, height: 0.5 },
          textShadowRadius: 1,
        }),
  },
  bold: {
    fontWeight: '800',
    fontSize: 15,
    letterSpacing: 0.3,
  },
  italic: {
    fontStyle: 'italic',
  },
  underline: {
    textDecorationLine: 'underline',
  },
  strikethrough: {
    textDecorationLine: 'line-through',
  },
  code: {
    fontFamily: Platform.OS === 'ios' ? 'Courier' : 'monospace',
    backgroundColor: 'rgba(0, 0, 0, 0.1)',
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 3,
    fontSize: 14,
    lineHeight: 18,
  },
  special: {
    fontWeight: '700',
    color: '#FFD700',
    backgroundColor: 'rgba(255, 215, 0, 0.15)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: 'rgba(255, 215, 0, 0.5)',
    fontSize: 15,
    lineHeight: 20,
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 1px rgba(255, 215, 0, 0.3)' }
      : {
          textShadowColor: 'rgba(255, 215, 0, 0.3)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 1,
        }),
  },
  link: {
    color: '#007AFF',
    textDecorationLine: 'underline',
  },
  mention: {
    color: '#007AFF',
    fontWeight: '600',
  },
  hashtag: {
    color: '#1DA1F2',
    fontWeight: '600',
  },
  searchHighlight: {
    backgroundColor: 'rgba(250, 204, 21, 0.38)',
  },
});
