import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { sharedFileService, normalizeSharedFileName, type SharedFileRecord } from '@/services/sharedFileService';
import { FileViewer } from '@/components/FileViewer';
import { useTheme } from '@/hooks/useTheme';

const sanitizeFileName = (name: string) => (name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');

export default function SharedFileViewPage() {
  const { theme } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams();
  const token = typeof params.token === 'string' ? params.token : '';

  const [loading, setLoading] = useState(true);
  const [record, setRecord] = useState<SharedFileRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tryOpenNativeApp = useCallback(() => {
    if (Platform.OS !== 'web') return;
    if (!token.trim()) return;

    const isProbablyMobile = (() => {
      try {
        const ua = (navigator.userAgent || '').toLowerCase();
        return /android|iphone|ipad|ipod/.test(ua);
      } catch {
        return false;
      }
    })();

    if (!isProbablyMobile) return;

    const scheme = 'com.sneha.tution';
    const safeToken = encodeURIComponent(token.trim());
    const deepLink = `${scheme}://shared/${safeToken}`;

    try {
      window.location.href = deepLink;
    } catch {
      // ignore
    }
  }, [token]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    tryOpenNativeApp();
  }, [tryOpenNativeApp]);

  useEffect(() => {
    let mounted = true;
    const run = async () => {
      if (!token.trim()) {
        setError('Missing shared link token');
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const r = await sharedFileService.fetchPublicSharedFile(token);
        if (!mounted) return;
        setRecord(r);
      } catch (e: any) {
        if (!mounted) return;
        setError(e?.message || 'Unable to load shared file');
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    };
    void run();
    return () => {
      mounted = false;
    };
  }, [token]);

  const file = record?.file;
  const fileUrl = (file?.url || '').trim();
  const fileName = normalizeSharedFileName({ fileUrl, fileName: file?.fileName || '' }) || 'Shared file';
  const fileType = file?.fileType || '';
  const fileSize = file?.fileSize;
  const thumbnailUrl = file?.thumbnailUrl;

  const handleDownload = useCallback(async () => {
    if (!fileUrl) {
      Alert.alert('Download', 'Missing file URL');
      return;
    }

    try {
      if (Platform.OS === 'web' && typeof document !== 'undefined') {
        const response = await fetch(fileUrl, { mode: 'cors' });
        if (!response.ok) {
          throw new Error('Download failed');
        }
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = sanitizeFileName(fileName);
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(objectUrl);
        return;
      }

      const FileSystem = require('expo-file-system') as typeof import('expo-file-system');
      const Sharing = require('expo-sharing') as typeof import('expo-sharing');

      const downloadName = sanitizeFileName(fileName);
      const downloadPath = `${FileSystem.documentDirectory}${downloadName}`;
      const result = await FileSystem.downloadAsync(fileUrl, downloadPath);
      if (result.status !== 200) {
        throw new Error('Download failed');
      }

      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(result.uri);
        return;
      }

      Alert.alert('Saved', `File stored at ${result.uri}`);
    } catch (e: any) {
      Alert.alert('Download failed', e?.message || 'Unable to download');
    }
  }, [fileName, fileUrl]);

  const headerBg = theme.background;
  const cardBg = theme.surface;

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: headerBg }}>
      <View style={{ flex: 1, padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 12 }}>
        {Platform.OS === 'web' ? (
          <TouchableOpacity
            onPress={tryOpenNativeApp}
            style={{ marginRight: 10, paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: cardBg, borderWidth: 1, borderColor: theme.border }}
          >
            <Text style={{ color: theme.text, fontWeight: '600' }}>Open in app</Text>
          </TouchableOpacity>
        ) : null}
        <TouchableOpacity
          onPress={() => router.replace('/(tabs)')}
          style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: cardBg, borderWidth: 1, borderColor: theme.border }}
        >
          <Text style={{ color: theme.text, fontWeight: '600' }}>Close</Text>
        </TouchableOpacity>
      </View>

      <View style={{ padding: 14, borderRadius: 14, backgroundColor: cardBg, borderWidth: 1, borderColor: theme.border }}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: theme.text, marginBottom: 4 }}>Shared file</Text>
        <Text style={{ fontSize: 13, color: theme.textSecondary }}>Open, preview, or save this file.</Text>
      </View>

      <View style={{ height: 12 }} />

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={theme.primary} />
          <Text style={{ marginTop: 10, color: theme.textSecondary }}>Loading…</Text>
        </View>
      ) : error ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <Text style={{ color: theme.error, fontWeight: '700', marginBottom: 8 }}>Link unavailable</Text>
          <Text style={{ color: theme.textSecondary, textAlign: 'center' }}>{error}</Text>
        </View>
      ) : !fileUrl ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <Text style={{ color: theme.textSecondary }}>Missing file info.</Text>
        </View>
      ) : (
        <View style={{ marginTop: 4 }}>
          <FileViewer
            fileUrl={fileUrl}
            fileName={fileName}
            fileType={fileType}
            fileSize={fileSize}
            thumbnailUrl={thumbnailUrl}
            onDownload={handleDownload}
            remoteFileUrl={fileUrl}
            previewHeight={450}
          />
        </View>
      )}
      </View>
    </SafeAreaView>
  );
}
