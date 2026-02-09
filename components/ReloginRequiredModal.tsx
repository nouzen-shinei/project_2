import React, { useCallback, useState } from 'react';
import { Platform } from 'react-native';
import { AlertTriangle } from 'lucide-react-native';
import ConfirmationModal from './ConfirmationModal';
import { useTheme } from '../hooks/useTheme';
import { useAuth, authService } from '../hooks/useAuthUnified';
import { logger } from '../lib/logger';

export default function ReloginRequiredModal() {
  const { theme } = useTheme();
  const { user, reloginRequired } = useAuth();
  const [isProcessing, setIsProcessing] = useState(false);

  const visible = Boolean(reloginRequired);

  const handleRelogin = useCallback(async () => {
    if (isProcessing) return;
    setIsProcessing(true);
    try {
      await authService.signOut();
      authService.clearReloginRequired();
    } catch (error) {
      logger.warn('Relogin sign-out failed:', error);
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing]);

  return (
    <ConfirmationModal
      visible={visible}
      onClose={() => {}}
      title="Session update required"
      message={
        'We detected a permission change. Please re-login to refresh your access.'
      }
      icon={<AlertTriangle size={28} color={theme.warning} />}
      showCloseButton={false}
      showCancelButton={false}
      showConfirmButton={true}
      confirmText={Platform.OS === 'web' ? 'Sign out & re-login' : 'Re-login'}
      confirmStyle="primary"
      onConfirm={handleRelogin}
      autoCloseOnConfirm={false}
      confirmLoading={isProcessing}
      cancelDisabled={true}
      statusType="warning"
      statusMessage="This will resolve after re-login."
    />
  );
}
