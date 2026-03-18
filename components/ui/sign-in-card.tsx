import { logger } from '@/lib/logger';
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  Image,
  Platform,
  Linking,
  ScrollView,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSharedTopPadding } from '@/hooks/useSharedTopPadding';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { Shield, Users, BookOpen, LogIn } from 'lucide-react-native';

const { width, height } = Dimensions.get('window');

interface SignInCardProps {
  onGoogleSignIn?: () => void;
  onReviewerQuickSignIn?: () => void;
  reviewerQuickJoinEnabled?: boolean;
  reviewerQuickJoinCenterName?: string;
  loading?: boolean;
  error?: string | null;
  success?: string | null;
}

const AnimatedTouchableOpacity = Animated.createAnimatedComponent(TouchableOpacity);
const AnimatedView = Animated.createAnimatedComponent(View);

export default function SignInCard({
  onGoogleSignIn,
  onReviewerQuickSignIn,
  reviewerQuickJoinEnabled,
  reviewerQuickJoinCenterName,
  loading,
  error,
  success,
}: SignInCardProps) {
  const sharedTopPadding = useSharedTopPadding();
  // Debug logging for error
  if (__DEV__ && error) {
    logger.debug('📱 SignInCard: Received error:', error);
    logger.debug('📱 SignInCard: Platform:', Platform.OS);
    logger.debug('📱 SignInCard: Is device ban error:', error.includes('DEVICE_BAN_ERROR:'));
  }
  
  // Clean the error message for display (remove internal marker)
  const displayError = error && error.includes('DEVICE_BAN_ERROR:') 
    ? error.replace('DEVICE_BAN_ERROR:', '') 
    : error;
  const displaySuccess = success || null;
  
  // Animation values for beautiful effects
  const cardScale = useSharedValue(1);
  const glowOpacity = useSharedValue(0.2);
  const lightBeamPosition = useSharedValue(-50);
  const buttonScale = useSharedValue(1);
  const cardRotateX = useSharedValue(0);
  const cardRotateY = useSharedValue(0);

  // Animated styles
  const cardAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { scale: cardScale.value },
      { rotateX: `${cardRotateX.value}deg` },
      { rotateY: `${cardRotateY.value}deg` },
    ],
  }));

  const glowAnimatedStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
  }));

  const topLightBeamAnimatedStyle = useAnimatedStyle(() => ({
    left: `${lightBeamPosition.value}%`,
  }));

  const rightLightBeamAnimatedStyle = useAnimatedStyle(() => ({
    top: `${lightBeamPosition.value}%`,
  }));

  const bottomLightBeamAnimatedStyle = useAnimatedStyle(() => ({
    right: `${lightBeamPosition.value}%`,
  }));

  const leftLightBeamAnimatedStyle = useAnimatedStyle(() => ({
    bottom: `${lightBeamPosition.value}%`,
  }));

  const buttonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  // Start beautiful animations on mount
  useEffect(() => {
    // Glow animation
    glowOpacity.value = withRepeat(
      withTiming(0.4, { duration: 4000 }),
      -1,
      true
    );

    // Light beam animation
    lightBeamPosition.value = withRepeat(
      withTiming(150, { duration: 3000 }),
      -1,
      false
    );
  }, []);

  const handlePressIn = () => {
    cardScale.value = withSpring(0.98);
    buttonScale.value = withSpring(0.95);
  };

  const handlePressOut = () => {
    cardScale.value = withSpring(1);
    buttonScale.value = withSpring(1);
  };

  const handleGoogleSignIn = () => {
    if (onGoogleSignIn) {
      onGoogleSignIn();
    }
  };

  const handleReviewerQuickSignIn = () => {
    if (onReviewerQuickSignIn) {
      onReviewerQuickSignIn();
    }
  };

  return (
    <View style={styles.container}>
      {/* Background gradient effect - matches the purple OnlyPipe style */}
      <LinearGradient
        colors={['rgba(168, 85, 247, 0.4)', 'rgba(147, 51, 234, 0.5)', '#000000']}
        style={styles.backgroundGradient}
      />
      
      {/* Beautiful background effects - Enhanced */}
      <View style={styles.backgroundEffects}>
        {/* Top radial glow */}
        <AnimatedView style={[styles.topRadialGlow, glowAnimatedStyle]} />
        <AnimatedView style={[styles.topRadialGlowSecondary, glowAnimatedStyle]} />
        <AnimatedView style={[styles.bottomRadialGlow, glowAnimatedStyle]} />
        
        {/* Animated glow spots */}
        <View style={styles.floatingGlow1} />
        <View style={styles.floatingGlow2} />
        
        {/* Moving light beams */}
        <AnimatedView style={[styles.lightBeam, topLightBeamAnimatedStyle]} />
        
        {/* Noise texture overlay */}
        <View style={styles.noiseOverlay} />
      </View>

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={[styles.scrollContent, { paddingTop: sharedTopPadding }]}
        bounces={false}
        showsVerticalScrollIndicator={false}
      >
        {/* Header - KEEPING ORIGINAL EXACTLY as "Tuition Manager" */}
        <View style={styles.header}>
          <View style={styles.logoContainer}>
            <BookOpen size={48} color="#ffffff" />
          </View>
          <Text style={styles.title}>Tuition Manager</Text>
          <Text style={styles.subtitle}>Professional Tuition Management System</Text>
        </View>

        {/* Features - KEEPING ORIGINAL EXACTLY */}
        <View style={styles.featuresContainer}>
          <View style={styles.feature}>
            <Users size={24} color="#ffffff" />
            <Text style={styles.featureText}>Student Management</Text>
          </View>
          <View style={styles.feature}>
            <Shield size={24} color="#ffffff" />
            <Text style={styles.featureText}>Secure Access</Text>
          </View>
        </View>

        <AnimatedView style={[styles.glassContainer, cardAnimatedStyle]}>
          {/* Card glow effect */}
          <AnimatedView style={[styles.cardGlow, glowAnimatedStyle]} />
          
          {/* Traveling light beam effects around the card */}
          <View style={styles.lightBeamContainer}>
            <AnimatedView style={[styles.topLightBeam, topLightBeamAnimatedStyle]} />
            <AnimatedView style={[styles.rightLightBeam, rightLightBeamAnimatedStyle]} />
            <AnimatedView style={[styles.bottomLightBeam, bottomLightBeamAnimatedStyle]} />
            <AnimatedView style={[styles.leftLightBeam, leftLightBeamAnimatedStyle]} />
            
            {/* Corner glow spots */}
            <AnimatedView style={[styles.cornerGlow1, glowAnimatedStyle]} />
            <AnimatedView style={[styles.cornerGlow2, glowAnimatedStyle]} />
            <AnimatedView style={[styles.cornerGlow3, glowAnimatedStyle]} />
            <AnimatedView style={[styles.cornerGlow4, glowAnimatedStyle]} />
          </View>
          
          {/* Card border glow */}
          <View style={styles.cardBorderGlow} />
          
          <View style={styles.loginCard}>
            {/* Subtle inner patterns */}
            <View style={styles.innerPattern} />
            
            <View style={styles.cardHeader}>
              <LogIn size={32} color="#ffffff" />
              <Text style={styles.cardTitle}>Secure Login</Text>
              <Text style={styles.cardSubtitle}>
                Sign in with your Google account and create or pick any coaching center
              </Text>
            </View>

            {/* Error message - Enhanced for better visibility */}
            {displayError && (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText} numberOfLines={0}>
                  {displayError}
                </Text>
              </View>
            )}

            {/* Success message - mirrors error styling theme with success colors */}
            {displaySuccess && !displayError && (
              <View style={styles.successContainer}>
                <Text style={styles.successText} numberOfLines={0}>
                  {displaySuccess}
                </Text>
              </View>
            )}

            {/* Google Sign In Button - KEEPING ORIGINAL EXACTLY */}
            <AnimatedTouchableOpacity
              style={[styles.googleButton, buttonAnimatedStyle]}
              onPress={handleGoogleSignIn}
              onPressIn={handlePressIn}
              onPressOut={handlePressOut}
              disabled={loading}
            >
              {/* Button glow effect */}
              <View style={styles.buttonGlow} />
              
              {loading ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <>
                  <Image
                    source={{ uri: 'https://developers.google.com/identity/images/g-logo.png' }}
                    style={styles.googleIcon}
                  />
                  <Text style={styles.googleButtonText}>Continue with Google</Text>
                </>
              )}
            </AnimatedTouchableOpacity>

            {reviewerQuickJoinEnabled && (
              <TouchableOpacity
                style={styles.reviewerQuickButton}
                onPress={handleReviewerQuickSignIn}
                disabled={loading}
              >
                <Text style={styles.reviewerQuickButtonText}>
                  Flavortown Reviewer Quick Sign-In to {reviewerQuickJoinCenterName || 'legacy-coachin'}
                </Text>
              </TouchableOpacity>
            )}

            {/* <View style={styles.securityNote}>
              <Shield size={16} color="rgba(255, 255, 255, 0.7)" />
              <Text style={styles.securityText}>
                Any educator with Google sign-in can onboard and switch tenants
              </Text>
            </View> */}
          </View>
        </AnimatedView>

        {/* Footer - KEEPING ORIGINAL EXACTLY */}
        <View style={styles.footer}>
            <Text style={styles.footerText}>
            Need help? Contact us from the app or visit our{' '}
            <Text
              style={[styles.footerText, { textDecorationLine: 'underline', color: '#a855f7' }]}
              onPress={() => {
              // Open the website in browser
              if (Platform.OS === 'web') {
                window.open('https://vipika.in/', '_blank');
              } else {
                // For native, use Linking
                Linking.openURL('https://vipika.in/');
              }
              }}
            >
              website
            </Text>
            </Text>
            <Text style={styles.footerText}>
              {' '}•{' '}
              <Text
                style={[styles.footerText, { textDecorationLine: 'underline', color: '#a855f7' }]}
                onPress={() => {
                  if (Platform.OS === 'web') {
                    window.open('/privacy-policy.html', '_blank');
                  } else {
                    Linking.openURL('https://tuitionmanager.app/privacy-policy.html');
                  }
                }}
              >
                Privacy Policy
              </Text>
              {' '}•{' '}
              <Text
                style={[styles.footerText, { textDecorationLine: 'underline', color: '#a855f7' }]}
                onPress={() => {
                  if (Platform.OS === 'web') {
                    window.open('/terms-of-service.html', '_blank');
                  } else {
                    Linking.openURL('https://tuitionmanager.app/terms-of-service.html');
                  }
                }}
              >
                Terms of Service
              </Text>
            </Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000', // Black background like in the design
    width: '100%',
    maxWidth: '100%',
    overflow: 'hidden',
  },
  backgroundGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  backgroundEffects: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
  },
  // Enhanced background glows inspired by the design
  topRadialGlow: {
    position: 'absolute',
    top: -height * 0.05,
    left: '50%',
    width: width * 1.2,
    height: height * 0.6,
    backgroundColor: 'rgba(168, 85, 247, 0.2)', // purple-400/20
    borderRadius: width * 0.6,
    transform: [{ translateX: -width * 0.6 }],
  },
  topRadialGlowSecondary: {
    position: 'absolute',
    top: 0,
    left: '50%',
    width: width,
    height: height * 0.6,
    backgroundColor: 'rgba(196, 181, 253, 0.2)', // purple-300/20
    borderRadius: width * 0.5,
    transform: [{ translateX: -width * 0.5 }],
  },
  bottomRadialGlow: {
    position: 'absolute',
    bottom: 0,
    left: '50%',
    width: width * 0.9,
    height: height * 0.9,
    backgroundColor: 'rgba(168, 85, 247, 0.2)', // purple-400/20
    borderRadius: width * 0.45,
    transform: [{ translateX: -width * 0.45 }],
  },
  topGlow: {
    position: 'absolute',
    top: -50,
    left: -50,
    right: -50,
    height: 200,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 200,
    transform: [{ scaleX: 2 }],
  },
  bottomGlow: {
    position: 'absolute',
    bottom: -100,
    left: -100,
    right: -100,
    height: 300,
    backgroundColor: 'rgba(118, 75, 162, 0.3)',
    borderRadius: 300,
    transform: [{ scaleX: 1.5 }],
  },
  floatingGlow1: {
    position: 'absolute',
    top: '25%',
    left: '25%',
    width: 100,
    height: 100,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 50,
  },
  floatingGlow2: {
    position: 'absolute',
    bottom: '25%',
    right: '25%',
    width: 100,
    height: 100,
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 50,
  },
  noiseOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.03,
    backgroundColor: 'transparent',
  },
  lightBeam: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    transform: [{ rotate: '15deg' }],
  },
  scrollView: {
    flex: 1,
    maxWidth: '100%',
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 40,
    width: '100%',
    maxWidth: '100%',
  },
  header: {
    alignItems: 'center',
    marginBottom: 40,
  },
  logoContainer: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255, 255, 255, 0.1)', // More subtle
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  title: {
    fontSize: 32,
    fontFamily: 'Poppins-Bold',
    color: '#ffffff',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    fontFamily: 'Inter-Regular',
    color: 'rgba(255, 255, 255, 0.9)',
    textAlign: 'center',
    lineHeight: 24,
  },
  featuresContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 40,
    marginBottom: 40,
  },
  feature: {
    alignItems: 'center',
  },
  featureText: {
    fontSize: 14,
    fontFamily: 'Inter-Medium',
    color: '#ffffff',
    marginTop: 8,
  },
  glassContainer: {
    borderRadius: 24,
    marginBottom: 30,
    overflow: 'hidden',
    boxShadow: '0 20px 30px rgba(255, 255, 255, 0.1)',
    elevation: 20,
  },
  // Enhanced card effects
  cardGlow: {
    position: 'absolute',
    top: -1,
    left: -1,
    right: -1,
    bottom: -1,
    borderRadius: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
  },
  lightBeamContainer: {
    position: 'absolute',
    top: -1,
    left: -1,
    right: -1,
    bottom: -1,
    borderRadius: 24,
    overflow: 'hidden',
  },
  topLightBeam: {
    position: 'absolute',
    top: 0,
    height: 3,
    width: '50%',
    backgroundColor: 'rgba(255, 255, 255, 0.3)', // Reduced opacity
  },
  rightLightBeam: {
    position: 'absolute',
    right: 0,
    width: 3,
    height: '50%',
    backgroundColor: 'rgba(255, 255, 255, 0.3)', // Reduced opacity
  },
  bottomLightBeam: {
    position: 'absolute',
    bottom: 0,
    height: 3,
    width: '50%',
    backgroundColor: 'rgba(255, 255, 255, 0.3)', // Reduced opacity
  },
  leftLightBeam: {
    position: 'absolute',
    left: 0,
    width: 3,
    height: '50%',
    backgroundColor: 'rgba(255, 255, 255, 0.3)', // Reduced opacity
  },
  cornerGlow1: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: 'rgba(255, 255, 255, 0.2)', // Reduced opacity
  },
  cornerGlow2: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.3)', // Reduced opacity
  },
  cornerGlow3: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255, 255, 255, 0.3)', // Reduced opacity
  },
  cornerGlow4: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: 'rgba(255, 255, 255, 0.2)', // Reduced opacity
  },
  cardBorderGlow: {
    position: 'absolute',
    top: -0.5,
    left: -0.5,
    right: -0.5,
    bottom: -0.5,
    borderRadius: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.03)', // Much more subtle
  },
  loginCard: {
    backgroundColor: 'rgba(0, 0, 0, 0.4)', // Glass effect like in the design
    borderRadius: 24,
    padding: 30,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.05)', // Very subtle border
    boxShadow: '0 1px 0 rgba(255, 255, 255, 0.1)',
  },
  innerPattern: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0.03,
    backgroundColor: 'transparent',
  },
  cardHeader: {
    alignItems: 'center',
    marginBottom: 30,
  },
  cardTitle: {
    fontSize: 24,
    fontFamily: 'Poppins-SemiBold',
    color: '#ffffff',
    marginTop: 16,
    marginBottom: 8,
    ...(Platform.OS === 'web' ? { textShadow: '0 1px 3px rgba(0, 0, 0, 0.3)' } : {
      textShadowColor: 'rgba(0, 0, 0, 0.3)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    }),
  },
  cardSubtitle: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    color: 'rgba(255, 255, 255, 0.9)',
    textAlign: 'center',
    lineHeight: 20,
    ...(Platform.OS === 'web' ? { textShadow: '0 1px 2px rgba(0, 0, 0, 0.2)' } : {
      textShadowColor: 'rgba(0, 0, 0, 0.2)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 2,
    }),
  },
  errorContainer: {
    backgroundColor: Platform.OS === 'web' ? 'rgba(254, 242, 242, 0.9)' : 'rgba(239, 68, 68, 0.1)',
    borderWidth: Platform.OS === 'web' ? 1 : 2,
    borderColor: Platform.OS === 'web' ? 'rgba(254, 202, 202, 0.6)' : '#ef4444',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    ...(Platform.OS !== 'web' && {
      shadowColor: '#ef4444',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.3,
      shadowRadius: 4,
      elevation: 4,
    }),
  },
  errorText: {
    fontSize: Platform.OS === 'web' ? 14 : 15,
    fontFamily: 'Inter-Medium',
    color: Platform.OS === 'web' ? '#dc2626' : '#ffffff',
    textAlign: 'center',
    lineHeight: 20,
    ...(Platform.OS !== 'web' && {
      textShadowColor: 'rgba(0, 0, 0, 0.5)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 2,
    }),
  },
  successContainer: {
    backgroundColor: Platform.OS === 'web' ? 'rgba(236, 253, 245, 0.9)' : 'rgba(34, 197, 94, 0.12)',
    borderWidth: Platform.OS === 'web' ? 1 : 2,
    borderColor: Platform.OS === 'web' ? 'rgba(187, 247, 208, 0.6)' : '#22c55e',
    borderRadius: 12,
    padding: 16,
    marginBottom: 20,
    ...(Platform.OS !== 'web' && {
      shadowColor: '#22c55e',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 4,
      elevation: 4,
    }),
  },
  successText: {
    fontSize: Platform.OS === 'web' ? 14 : 15,
    fontFamily: 'Inter-Medium',
    color: Platform.OS === 'web' ? '#065f46' : '#ffffff',
    textAlign: 'center',
    lineHeight: 20,
    ...(Platform.OS !== 'web' && {
      textShadowColor: 'rgba(0, 0, 0, 0.5)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 2,
    }),
  },
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#ffffff', // White button like in the design
    paddingVertical: 16,
    paddingHorizontal: 24,
    borderRadius: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    ...(Platform.OS === 'web' ? { boxShadow: '0 4px 12px rgba(255, 255, 255, 0.2)' } : {
      shadowColor: 'rgba(255, 255, 255, 0.2)',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.4,
      shadowRadius: 12,
    }),
    elevation: 8,
    overflow: 'hidden',
  },
  buttonGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 14,
  },
  googleIcon: {
    width: 20,
    height: 20,
    marginRight: 12,
  },
  googleButtonText: {
    fontSize: 16,
    fontFamily: 'Inter-SemiBold',
    color: '#000000', // Black text on white button
  },
  reviewerQuickButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(168, 85, 247, 0.6)',
    backgroundColor: '#F9E8D2',
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  reviewerQuickButtonText: {
    fontSize: 14,
    fontFamily: 'Inter-SemiBold',
    color: '#000000',
    textAlign: 'center',
  },
  securityNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.2)',
  },
  securityText: {
    fontSize: 12,
    fontFamily: 'Inter-Regular',
    color: 'rgba(255, 255, 255, 0.8)',
    marginLeft: 6,
  },
  footer: {
    alignItems: 'center',
  },
  footerText: {
    fontSize: 14,
    fontFamily: 'Inter-Regular',
    color: 'rgba(255, 255, 255, 0.8)',
    textAlign: 'center',
  },
});
