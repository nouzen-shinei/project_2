/**
 * Web: react-native-web's Modal as-is. The toast layer from AppToast.web.tsx
 * is already drawn above every modal, so no per-modal toast host is needed.
 * iOS/Android use AppModal.tsx.
 */
// eslint-disable-next-line no-restricted-imports -- the one place allowed to re-export the RN Modal
export { Modal } from 'react-native';
export type { ModalProps } from 'react-native';
