export type ModalAlertButtonStyle = 'default' | 'cancel' | 'destructive' | 'primary';

export type ModalAlertVariant = 'default' | 'warning';

export interface ModalAlertButton {
  text: string;
  onPress?: () => void;
  style?: ModalAlertButtonStyle;
}

export interface ModalAlertPayload {
  title: string;
  message?: string;
  buttons?: ModalAlertButton[];
  variant?: ModalAlertVariant;
}

type Presenter = (payload: ModalAlertPayload) => void;

let presenter: Presenter | null = null;

export function setModalAlertPresenter(next: Presenter | null) {
  presenter = next;
}

export function tryPresentModalAlert(payload: ModalAlertPayload): boolean {
  if (presenter) {
    presenter(payload);
    return true;
  }

  // As a last resort (e.g., very early in app startup), fall back to the browser alert.
  // This is web-only safe and avoids dropping important messages.
  if (typeof window !== 'undefined' && typeof window.alert === 'function') {
    const message = payload.message ? `${payload.title}\n\n${payload.message}` : payload.title;
    window.alert(message);
    return true;
  }

  return false;
}

export function presentModalAlert(payload: ModalAlertPayload) {
  tryPresentModalAlert(payload);
}
