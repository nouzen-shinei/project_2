import { logger } from '@/lib/logger';
import React from 'react';
import { Text, TouchableOpacity, Linking, Alert, StyleSheet } from 'react-native';

/**
 * LinkifiedText component that automatically detects and makes clickable:
 * - URLs (http/https/www) - Opens in external browser/new tab
 * - Email addresses - Opens in email app
 * - Phone numbers - Opens in phone app
 * - Addresses/locations - Opens in maps app
 * - YouTube links - Opens in YouTube app
 * - Social media handles (@username) - Opens profile
 * - Hashtags (#hashtag) - Search functionality
 * - File extensions - Download/open functionality
 * - Coordinates (lat, lng) - Opens in maps
 * - Dates/times - Calendar integration
 * - Stock symbols ($AAPL) - Financial apps
 * - Mentions (@user) - User profiles
 * - IP addresses - Network utilities
 * - GitHub repos (github.com/user/repo) - Opens in GitHub app
 * - Zoom meeting IDs - Opens in Zoom app
 */

interface LinkifiedTextProps {
  text: string;
  style?: any;
  linkStyle?: any;
}

interface LinkMatch {
  type: 'url' | 'email' | 'phone' | 'location' | 'youtube' | 'mention' | 'hashtag' | 'coordinates' | 'stock' | 'date' | 'file' | 'ip' | 'github' | 'zoom' | 'text';
  text: string;
  url?: string;
  start: number;
  end: number;
}

export default function LinkifiedText({ text, style, linkStyle }: LinkifiedTextProps) {
  // Regular expressions for different types of links
  const urlRegex = /https?:\/\/[^\s]+|www\.[^\s]+/gi;
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi;
  const phoneRegex = /(\+\d{1,3}[-.\s]?)?([(]?\d{3}[)]?[-.\s]?)?\d{3}[-.\s]?\d{4}|\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\+\d{1,3}[-.\s]?\d{5,15}/gi;
  const locationRegex = /\b\d+\s+[A-Za-z\s,]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Place|Pl|Court|Ct|Circle|Cir)\b[A-Za-z\s,0-9]*(?:,\s*[A-Za-z\s]+(?:,\s*[A-Z]{2})?(?:\s+\d{5})?)?/gi;
  const youtubeRegex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/gi;
  const mentionRegex = /@[a-zA-Z0-9_]+/gi;
  const hashtagRegex = /#[a-zA-Z0-9_]+/gi;
  const coordinatesRegex = /-?\d+\.?\d*,\s*-?\d+\.?\d*/gi;
  const stockRegex = /\$[A-Z]{1,5}/gi;
  const dateRegex = /\b\d{1,2}\/\d{1,2}\/\d{2,4}|\b\d{4}-\d{2}-\d{2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4}/gi;
  const fileRegex = /[a-zA-Z0-9_-]+\.(pdf|doc|docx|xls|xlsx|ppt|pptx|txt|zip|rar|jpg|jpeg|png|gif|mp4|mov|avi|mp3|wav)/gi;
  const ipRegex = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gi;
  const githubRegex = /(?:https?:\/\/)?github\.com\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+/gi;
  const zoomRegex = /(?:https?:\/\/)?[a-zA-Z0-9.-]*zoom\.us\/[a-zA-Z0-9?=&\/]+|Meeting ID:\s*(\d{9,11})/gi;

  const parseText = (inputText: string): LinkMatch[] => {
    const matches: LinkMatch[] = [];
    const linkRanges = new Set<string>();
    
    // Find URLs (but exclude YouTube and GitHub URLs to handle them separately)
    let match;
    while ((match = urlRegex.exec(inputText)) !== null) {
      const url = match[0];
      // Skip if it's a YouTube, GitHub, or Zoom URL (will be handled by specific regex)
      if (!url.includes('youtube.com') && !url.includes('youtu.be') && 
          !url.includes('github.com') && !url.includes('zoom.us')) {
        let finalUrl = url;
        if (!finalUrl.startsWith('http')) {
          finalUrl = 'https://' + finalUrl;
        }
        const start = match.index;
        const end = match.index + url.length;
        const key = `${start}-${end}`;
        if (linkRanges.has(key)) {
          continue;
        }
        linkRanges.add(key);
        matches.push({
          type: 'url',
          text: url,
          url: finalUrl,
          start,
          end
        });
      }
    }

    // Reset regex
    urlRegex.lastIndex = 0;

    // Find YouTube links
    while ((match = youtubeRegex.exec(inputText)) !== null) {
      const fullMatch = match[0];
      const videoId = match[1];
      const start = match.index;
      const end = match.index + fullMatch.length;
      const key = `${start}-${end}`;
      if (linkRanges.has(key)) {
        continue;
      }
      linkRanges.add(key);
      matches.push({
        type: 'youtube',
        text: fullMatch,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        start,
        end
      });
    }

    // Reset regex
    youtubeRegex.lastIndex = 0;
    
    // Find emails
    while ((match = emailRegex.exec(inputText)) !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      const key = `${start}-${end}`;
      if (linkRanges.has(key)) {
        continue;
      }
      linkRanges.add(key);
      matches.push({
        type: 'email',
        text: match[0],
        url: `mailto:${match[0]}`,
        start,
        end
      });
    }

    // Reset regex
    emailRegex.lastIndex = 0;
    
    // Find phone numbers
  while ((match = phoneRegex.exec(inputText)) !== null) {
      // Only match if it looks like a real phone number (not just random digits)
      const phoneText = match[0];
      const digitsOnly = phoneText.replace(/\D/g, '');
      
      // Valid phone numbers should have 10-15 digits
      if (digitsOnly.length >= 10 && digitsOnly.length <= 15) {
        const start = match.index;
        const end = match.index + phoneText.length;
        const key = `${start}-${end}`;
        if (linkRanges.has(key)) {
          continue;
        }
        linkRanges.add(key);
        matches.push({
          type: 'phone',
          text: phoneText,
          url: `tel:${digitsOnly}`,
          start,
          end
        });
      }
    }

    // Reset regex
    phoneRegex.lastIndex = 0;

    // Find locations/addresses
    while ((match = locationRegex.exec(inputText)) !== null) {
      const locationText = match[0];
      const start = match.index;
      const end = match.index + locationText.length;
      const key = `${start}-${end}`;
      if (linkRanges.has(key)) {
        continue;
      }
      linkRanges.add(key);
      matches.push({
        type: 'location',
        text: locationText,
        url: `maps://app?q=${encodeURIComponent(locationText)}`,
        start,
        end
      });
    }

    // Reset regex
    locationRegex.lastIndex = 0;

    // Find mentions (@username)
    while ((match = mentionRegex.exec(inputText)) !== null) {
      const mentionText = match[0];
      const username = mentionText.substring(1); // Remove @
      const start = match.index;
      const end = match.index + mentionText.length;
      const key = `${start}-${end}`;
      if (linkRanges.has(key)) {
        continue;
      }
      linkRanges.add(key);
      matches.push({
        type: 'mention',
        text: mentionText,
        url: `https://twitter.com/${username}`, // Default to Twitter, could be customized
        start,
        end
      });
    }

    // Reset regex
    mentionRegex.lastIndex = 0;

    // Find hashtags
    while ((match = hashtagRegex.exec(inputText)) !== null) {
      const hashtagText = match[0];
      const hashtag = hashtagText.substring(1); // Remove #
      const start = match.index;
      const end = match.index + hashtagText.length;
      const key = `${start}-${end}`;
      if (linkRanges.has(key)) {
        continue;
      }
      linkRanges.add(key);
      matches.push({
        type: 'hashtag',
        text: hashtagText,
        url: `https://twitter.com/hashtag/${hashtag}`, // Default to Twitter search
        start,
        end
      });
    }

    // Reset regex
    hashtagRegex.lastIndex = 0;

    // Find coordinates
  while ((match = coordinatesRegex.exec(inputText)) !== null) {
      const coordText = match[0];
      // Validate coordinates are reasonable
      const [lat, lng] = coordText.split(',').map(c => parseFloat(c.trim()));
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
        const start = match.index;
        const end = match.index + coordText.length;
        const key = `${start}-${end}`;
        if (linkRanges.has(key)) {
          continue;
        }
        linkRanges.add(key);
        matches.push({
          type: 'coordinates',
          text: coordText,
          url: `maps://app?q=${lat},${lng}`,
          start,
          end
        });
      }
    }

    // Reset regex
    coordinatesRegex.lastIndex = 0;

    // Find stock symbols
    while ((match = stockRegex.exec(inputText)) !== null) {
      const stockText = match[0];
      const symbol = stockText.substring(1); // Remove $
      const start = match.index;
      const end = match.index + stockText.length;
      const key = `${start}-${end}`;
      if (linkRanges.has(key)) {
        continue;
      }
      linkRanges.add(key);
      matches.push({
        type: 'stock',
        text: stockText,
        url: `https://finance.yahoo.com/quote/${symbol}`,
        start,
        end
      });
    }

    // Reset regex
    stockRegex.lastIndex = 0;

    // Find dates
    while ((match = dateRegex.exec(inputText)) !== null) {
      const dateText = match[0];
      const start = match.index;
      const end = match.index + dateText.length;
      const key = `${start}-${end}`;
      if (linkRanges.has(key)) {
        continue;
      }
      linkRanges.add(key);
      matches.push({
        type: 'date',
        text: dateText,
        // Could integrate with calendar app
        url: `calendar://`,
        start,
        end
      });
    }

    // Reset regex
    dateRegex.lastIndex = 0;

    // Find file references
    while ((match = fileRegex.exec(inputText)) !== null) {
      const fileText = match[0];
      const start = match.index;
      const end = match.index + fileText.length;
      const key = `${start}-${end}`;
      if (linkRanges.has(key)) {
        continue;
      }
      linkRanges.add(key);
      matches.push({
        type: 'file',
        text: fileText,
        // Could implement file search/download
        url: `file://${fileText}`,
        start,
        end
      });
    }

    // Reset regex
    fileRegex.lastIndex = 0;

    // Find IP addresses
    while ((match = ipRegex.exec(inputText)) !== null) {
      const ipText = match[0];
      // Validate IP address format
      const parts = ipText.split('.');
      const isValidIP = parts.every(part => {
        const num = parseInt(part);
        return num >= 0 && num <= 255;
      });
      
      if (isValidIP) {
        const start = match.index;
        const end = match.index + ipText.length;
        const key = `${start}-${end}`;
        if (linkRanges.has(key)) {
          continue;
        }
        linkRanges.add(key);
        matches.push({
          type: 'ip',
          text: ipText,
          url: `http://${ipText}`, // Could ping or access the IP
          start,
          end
        });
      }
    }

    // Reset regex
    ipRegex.lastIndex = 0;

    // Find GitHub repositories
    while ((match = githubRegex.exec(inputText)) !== null) {
      const githubText = match[0];
      let githubUrl = githubText;
      if (!githubUrl.startsWith('http')) {
        githubUrl = 'https://' + githubUrl;
      }
      const start = match.index;
      const end = match.index + githubText.length;
      const key = `${start}-${end}`;
      if (linkRanges.has(key)) {
        continue;
      }
      linkRanges.add(key);
      matches.push({
        type: 'github',
        text: githubText,
        url: githubUrl,
        start,
        end
      });
    }

    // Reset regex
    githubRegex.lastIndex = 0;

    // Find Zoom meeting links/IDs
    while ((match = zoomRegex.exec(inputText)) !== null) {
      const zoomText = match[0];
      let zoomUrl;
      
      if (zoomText.includes('zoom.us')) {
        // It's already a full URL
        zoomUrl = zoomText.startsWith('http') ? zoomText : 'https://' + zoomText;
      } else {
        // It's a meeting ID
        const meetingId = match[1] || zoomText.replace(/[^\d]/g, '');
        zoomUrl = `zoommtg://zoom.us/join?confno=${meetingId}`;
      }
      
      const start = match.index;
      const end = match.index + zoomText.length;
      const key = `${start}-${end}`;
      if (linkRanges.has(key)) {
        continue;
      }
      linkRanges.add(key);
      matches.push({
        type: 'zoom',
        text: zoomText,
        url: zoomUrl,
        start,
        end
      });
    }

    // Reset regex
    zoomRegex.lastIndex = 0;

    // Sort matches by start position (already unique)
    matches.sort((a, b) => a.start - b.start);

    return matches;
  };

  const handleLinkPress = async (match: LinkMatch) => {
    if (!match.url) return;

    try {
      let finalUrl = match.url;
      
      // Handle different link types with specific behaviors
      switch (match.type) {
        case 'location':
          // Try Apple Maps first (iOS), then Google Maps
          const appleMapsUrl = `maps://app?q=${encodeURIComponent(match.text)}`;
          const googleMapsUrl = `https://maps.google.com/maps?q=${encodeURIComponent(match.text)}`;
          
          const appleMapsSupported = await Linking.canOpenURL(appleMapsUrl);
          finalUrl = appleMapsSupported ? appleMapsUrl : googleMapsUrl;
          break;

        case 'coordinates':
          // Similar to location but for coordinates
          const [lat, lng] = match.text.split(',').map(c => c.trim());
          const coordAppleMaps = `maps://app?q=${lat},${lng}`;
          const coordGoogleMaps = `https://maps.google.com/maps?q=${lat},${lng}`;
          
          const coordAppleSupported = await Linking.canOpenURL(coordAppleMaps);
          finalUrl = coordAppleSupported ? coordAppleMaps : coordGoogleMaps;
          break;

        case 'youtube':
          // Try YouTube app first, fallback to web
          const youtubeAppUrl = finalUrl.replace('https://www.youtube.com', 'youtube://');
          const youtubeAppSupported = await Linking.canOpenURL(youtubeAppUrl);
          finalUrl = youtubeAppSupported ? youtubeAppUrl : finalUrl;
          break;

        case 'mention':
          // For mentions, could be customized based on app context
          // Default to Twitter but could check for internal user profiles
          break;

        case 'hashtag':
          // Similar to mentions, could be internal search or external
          break;

        case 'date':
          // Try to open calendar app
          const calendarSupported = await Linking.canOpenURL('calendar://');
          if (calendarSupported) {
            finalUrl = 'calendar://';
          } else {
            Alert.alert(
              'Date Detected',
              `Date: ${match.text}`,
              [{ text: 'OK' }]
            );
            return;
          }
          break;

        case 'file':
          // For file references, show an alert or implement file search
          Alert.alert(
            'File Reference',
            `File: ${match.text}\n\nThis could open a file browser or search functionality.`,
            [{ text: 'OK' }]
          );
          return;

        case 'stock':
          // Stock symbols - could open financial apps
          const symbol = match.text.substring(1);
          finalUrl = `https://finance.yahoo.com/quote/${symbol}`;
          break;

        case 'ip':
          // IP addresses - could ping or open in browser
          Alert.alert(
            'IP Address',
            `IP: ${match.text}\n\nThis could ping the address or open network utilities.`,
            [
              { text: 'Cancel' },
              { text: 'Open in Browser', onPress: () => Linking.openURL(`http://${match.text}`) }
            ]
          );
          return;

        case 'github':
          // GitHub repositories - try GitHub app first
          const githubAppUrl = finalUrl.replace('https://github.com', 'github://');
          const githubAppSupported = await Linking.canOpenURL(githubAppUrl);
          finalUrl = githubAppSupported ? githubAppUrl : finalUrl;
          break;

        case 'zoom':
          // Zoom meetings - try Zoom app first
          if (finalUrl.startsWith('zoommtg://')) {
            const zoomAppSupported = await Linking.canOpenURL(finalUrl);
            if (!zoomAppSupported) {
              // Fallback to web version
              const meetingId = match.text.replace(/[^\d]/g, '');
              finalUrl = `https://zoom.us/j/${meetingId}`;
            }
          }
          break;

        case 'url':
        case 'email':
        case 'phone':
        default:
          // Use the original URL for these types
          break;
      }
      
      // For web URLs, always try to open in external browser
      if (match.type === 'url' || match.type === 'youtube' || match.type === 'mention' || 
          match.type === 'hashtag' || match.type === 'stock' || match.type === 'github' || 
          match.type === 'zoom') {
        await Linking.openURL(finalUrl);
        return;
      }
      
      const supported = await Linking.canOpenURL(finalUrl);
      
      if (supported) {
        await Linking.openURL(finalUrl);
      } else {
        Alert.alert(
          'Cannot Open Link',
          `Cannot open ${match.type}: ${match.text}`,
          [{ text: 'OK' }]
        );
      }
    } catch (error) {
      logger.error('Error opening link:', error);
      Alert.alert(
        'Error',
        'Failed to open link. Please try again.',
        [{ text: 'OK' }]
      );
    }
  };

  const renderText = () => {
    const matches = parseText(text);
    
    if (matches.length === 0) {
      return <Text style={style}>{text}</Text>;
    }

    const elements: React.ReactNode[] = [];
    let lastIndex = 0;

    matches.forEach((match, index) => {
      // Add text before the link
      if (match.start > lastIndex) {
        elements.push(
          <Text key={`text-${index}`} style={style}>
            {text.substring(lastIndex, match.start)}
          </Text>
        );
      }

      // Add the clickable link with type-specific styling
      const getLinkColor = () => {
        if (linkStyle?.color) return linkStyle.color;
        
        // Default colors for different link types
        switch (match.type) {
          case 'mention': return '#1DA1F2'; // Twitter blue
          case 'hashtag': return '#1DA1F2'; // Twitter blue
          case 'youtube': return '#FF0000'; // YouTube red
          case 'stock': return '#00C851'; // Green for stocks
          case 'location':
          case 'coordinates': return '#4285F4'; // Google Maps blue
          case 'date': return '#FF6900'; // Orange for dates
          case 'file': return '#6C757D'; // Gray for files
          case 'ip': return '#17A2B8'; // Cyan for IP addresses
          case 'github': return '#333333'; // GitHub dark
          case 'zoom': return '#2D8CFF'; // Zoom blue
          default: return linkStyle?.color || '#007AFF'; // Default blue
        }
      };

      elements.push(
        <TouchableOpacity 
          key={`link-${index}`} 
          onPress={() => handleLinkPress(match)}
          activeOpacity={0.7}
        >
          <Text style={[
            style, 
            linkStyle, 
            styles.link,
            { color: getLinkColor() }
          ]}>
            {match.text}
          </Text>
        </TouchableOpacity>
      );

      lastIndex = match.end;
    });

    // Add remaining text after the last link
    if (lastIndex < text.length) {
      elements.push(
        <Text key="text-end" style={style}>
          {text.substring(lastIndex)}
        </Text>
      );
    }

    return <Text style={style}>{elements}</Text>;
  };

  return renderText();
}

const styles = StyleSheet.create({
  link: {
    textDecorationLine: 'underline',
  },
});
