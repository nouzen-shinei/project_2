import React, { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';
import ConfirmationModal from './ConfirmationModal';
import WebPortal from './WebPortal';
import { AlertTriangle } from 'lucide-react-native';
import { useTheme } from '../hooks/useTheme';
import {
  ModalAlertPayload,
  setModalAlertPresenter,
  type ModalAlertButton,
} from '../services/modalAlertService';

type Action = {
  text: string;
  style: 'default' | 'cancel' | 'destructive' | 'primary';
  onPress?: () => void;
};

function normalizeButtons(buttons?: ModalAlertButton[]): Action[] {
  const source = Array.isArray(buttons) && buttons.length ? buttons : [{ text: 'OK', style: 'primary' as const }];

  // Pick a primary action if none specified.
  let primaryAssigned = false;
  return source.map((b) => {
    const text = (b.text || '').trim() || 'OK';
    const style = b.style || 'default';

    if (style === 'cancel') {
      return { text, style: 'cancel', onPress: b.onPress };
    }
    if (style === 'destructive') {
      return { text, style: 'destructive', onPress: b.onPress };
    }
    if (style === 'primary') {
      primaryAssigned = true;
      return { text, style: 'primary', onPress: b.onPress };
    }

    if (!primaryAssigned) {
      primaryAssigned = true;
      return { text, style: 'primary', onPress: b.onPress };
    }

    return { text, style: 'default', onPress: b.onPress };
  });
}

export default function ModalAlertProvider({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  const [visible, setVisible] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [actions, setActions] = useState<Action[]>([]);
  const [variant, setVariant] = useState<'default' | 'warning'>('default');

  const payloadToModal = useMemo(
    () => ({
      visible,
      title,
      message,
      actions,
      variant,
    }),
    [visible, title, message, actions, variant]
  );

  useEffect(() => {
    const presenter = (payload: ModalAlertPayload) => {
      setTitle((payload.title || '').trim() || 'Alert');
      setMessage((payload.message || '').trim());
      setActions(normalizeButtons(payload.buttons));
      setVariant(payload.variant === 'warning' ? 'warning' : 'default');
      setVisible(true);
    };

    setModalAlertPresenter(presenter);
    return () => setModalAlertPresenter(null);
  }, []);

  return (
    <>
      {children}
      {Platform.OS === 'web' ? (
        <WebPortal active={payloadToModal.visible}>
          <ConfirmationModal
            visible={payloadToModal.visible}
            onClose={() => setVisible(false)}
            title={payloadToModal.title}
            message={payloadToModal.message}
            actions={payloadToModal.actions}
            icon={
              payloadToModal.variant === 'warning' ? (
                <AlertTriangle size={28} color={theme.warning} />
              ) : null
            }
            statusType={payloadToModal.variant === 'warning' ? 'warning' : 'neutral'}
            showCloseButton
          />
        </WebPortal>
      ) : (
        <ConfirmationModal
          visible={payloadToModal.visible}
          onClose={() => setVisible(false)}
          title={payloadToModal.title}
          message={payloadToModal.message}
          actions={payloadToModal.actions}
          icon={
            payloadToModal.variant === 'warning' ? (
              <AlertTriangle size={28} color={theme.warning} />
            ) : null
          }
          statusType={payloadToModal.variant === 'warning' ? 'warning' : 'neutral'}
          showCloseButton
        />
      )}
    </>
  );
}
