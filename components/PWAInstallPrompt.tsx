import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { canShowInstallPrompt, showInstallPrompt, isAppInstalled } from '../lib/pwa';

/**
 * PWA Install Prompt Component
 * Shows a prompt to install the web app on supported devices
 */
export default function PWAInstallPrompt() {
  const [canInstall, setCanInstall] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [showInstructions, setShowInstructions] = useState(false);

  useEffect(() => {
    // Only relevant on web
    if (Platform.OS !== 'web') {
      return;
    }

    // Check if already installed
    const installed = isAppInstalled();
    setIsInstalled(installed);

    if (installed) {
      return;
    }

    // Check if install prompt is available
    const checkInterval = setInterval(() => {
      const available = canShowInstallPrompt();
      if (available) {
        setCanInstall(true);
        clearInterval(checkInterval);
      }
    }, 1000);

    return () => clearInterval(checkInterval);
  }, []);

  const handleInstall = async () => {
    const accepted = await showInstallPrompt();
    if (accepted) {
      setIsInstalled(true);
      setCanInstall(false);
      setShowInstructions(false);
      return;
    }

    // If the browser doesn't provide a programmatic prompt (common on iOS Safari
    // and sometimes on first visit), show manual install instructions.
    setShowInstructions(true);
  };

  const handleDismiss = () => {
    setDismissed(true);
  };

  // Don't show if not on web, already installed, or dismissed
  if (Platform.OS !== 'web' || isInstalled || dismissed) {
    return null;
  }

  return (
    <View className="fixed bottom-4 left-4 right-4 md:left-auto md:right-4 md:max-w-sm bg-white dark:bg-gray-800 rounded-lg shadow-lg p-4 border border-gray-200 dark:border-gray-700 z-50">
      <View className="flex-row items-start justify-between mb-2">
        <Text className="text-base font-semibold text-gray-900 dark:text-white flex-1">
          Install Tuition Manager
        </Text>
        <TouchableOpacity
          onPress={handleDismiss}
          className="ml-2 p-1"
          accessibilityLabel="Dismiss install prompt"
        >
          <Text className="text-gray-500 dark:text-gray-400 text-xl leading-none">×</Text>
        </TouchableOpacity>
      </View>
      
      <Text className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        Install the app for quick access and offline support.
        {!canInstall ? ' If you don\'t see an install button, use your browser menu to install.' : ''}
      </Text>

      {showInstructions && (
        <View className="mb-3 rounded-lg bg-gray-50 dark:bg-gray-900 p-3">
          <Text className="text-sm text-gray-700 dark:text-gray-200">
            How to install:
          </Text>
          <Text className="text-xs text-gray-600 dark:text-gray-300 mt-1">
            - Chrome/Edge (desktop): menu → Install app
          </Text>
          <Text className="text-xs text-gray-600 dark:text-gray-300 mt-1">
            - Android Chrome: menu → Add to Home screen
          </Text>
          <Text className="text-xs text-gray-600 dark:text-gray-300 mt-1">
            - iPhone/iPad Safari: Share → Add to Home Screen
          </Text>
        </View>
      )}
      
      <View className="flex-row gap-2">
        <TouchableOpacity
          onPress={handleInstall}
          className="flex-1 bg-indigo-600 rounded-lg py-2.5 px-4"
          accessibilityLabel="Install app"
        >
          <Text className="text-white text-center font-semibold">Install</Text>
        </TouchableOpacity>
        
        <TouchableOpacity
          onPress={handleDismiss}
          className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-lg py-2.5 px-4"
          accessibilityLabel="Not now"
        >
          <Text className="text-gray-700 dark:text-gray-300 text-center font-semibold">Not Now</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
