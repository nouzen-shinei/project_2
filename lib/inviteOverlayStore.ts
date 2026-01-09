type Listener = (token: string | null) => void;

let activeToken: string | null = null;
const listeners = new Set<Listener>();

const notify = () => {
  listeners.forEach((listener) => {
    try {
      listener(activeToken);
    } catch (error) {
      console.warn('[inviteOverlayStore] listener failed', error);
    }
  });
};

export const inviteOverlayStore = {
  getToken(): string | null {
    return activeToken;
  },
  setToken(token: string | null) {
    activeToken = token?.trim() || null;
    notify();
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
};
