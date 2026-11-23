import React, { useContext, useState } from 'react';
// eslint-disable-next-line no-restricted-imports -- the one place allowed to wrap the RN Modal
import { Modal as RNModal, type ModalProps } from 'react-native';
import { ToastHost, ToastHostParentContext, toastHostStack } from './ToastHost';

/**
 * Drop-in replacement for react-native's `Modal` (same props) on iOS/Android.
 *
 * A Modal is a separate native window, so toasts rendered at the app root are
 * hidden behind it. This wrapper adds a toast host inside the Modal so toasts
 * fired while it is open are drawn on top of it; when it closes, a visible
 * toast moves back to the root (or the parent modal) for its remaining time.
 * Web uses AppModal.web.tsx, where the toast layer already sits above modals.
 */
export function Modal({ children, ...props }: ModalProps) {
  const parentHostId = useContext(ToastHostParentContext);
  const [hostId] = useState(toastHostStack.nextHostId);

  return (
    <RNModal {...props}>
      <ToastHostParentContext.Provider value={hostId}>{children}</ToastHostParentContext.Provider>
      <ToastHost
        hostId={hostId}
        kind="modal"
        parentId={parentHostId}
        // RN treats an omitted `visible` as true.
        enabled={props.visible !== false}
      />
    </RNModal>
  );
}

export type { ModalProps };
