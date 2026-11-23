import type { ToastShowParams } from 'react-native-toast-message';

/**
 * Routes react-native-toast-message toasts to the top-most toast host.
 *
 * On iOS/Android a react-native `Modal` is its own native window, so a toast
 * rendered at the app root is always drawn underneath an open Modal. To stay
 * on top, every Modal carries its own toast host (components/AppModal), and
 * this stack decides which single host renders the toast:
 *
 * - Modal hosts always rank above root hosts.
 * - Among modal hosts, the most recently opened one wins, except that a
 *   modal nested inside another always ranks above its parent (the two can
 *   register in the same commit, child first).
 *
 * Only the top host mounts a `<Toast>` instance. When the top host changes
 * while a toast is visible (a modal opens over it, or the modal showing it
 * closes), the toast is shown again on the new top host for the time it has
 * left, so a toast fired right before a modal closes is not lost with it.
 */

export type ToastHostKind = 'root' | 'modal';

type HostEntry = {
  id: number;
  kind: ToastHostKind;
  parentId: number | null;
  seq: number;
};

type ActiveToast = {
  token: number;
  params: ToastShowParams;
  shownAt: number;
  visibilityTime: number;
  autoHide: boolean;
  /** Host whose `<Toast>` instance is displaying it, if known. */
  hostId: number | null;
};

export type ToastShowFn = (params: ToastShowParams) => void;
export type ToastHideFn = () => void;

export type ToastHostStackOptions = {
  show: ToastShowFn;
  hide: ToastHideFn;
  defaultVisibilityTime: number;
  defaultAutoHide: boolean;
  now?: () => number;
};

/**
 * A toast that moves to another host is shown for at least this long, so it
 * does not just flash when it moves near the end of its time.
 */
export const MIN_MOVED_VISIBILITY_MS = 1500;

const noop = () => {};

export class ToastHostStack {
  private readonly hosts = new Map<number, HostEntry>();
  private readonly listeners = new Set<() => void>();
  private hostIdSeq = 0;
  private registrationSeq = 0;
  private tokenSeq = 0;
  private topHostId: number | null = null;
  private mountedHostId: number | null = null;
  private active: ActiveToast | null = null;
  private readonly now: () => number;

  constructor(private readonly options: ToastHostStackOptions) {
    this.now = options.now ?? Date.now;
  }

  nextHostId = (): number => {
    this.hostIdSeq += 1;
    return this.hostIdSeq;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getTopHostId = (): number | null => this.topHostId;

  registerHost(id: number, kind: ToastHostKind, parentId: number | null): void {
    this.registrationSeq += 1;
    this.hosts.set(id, { id, kind, parentId, seq: this.registrationSeq });
    this.recomputeTop();
  }

  unregisterHost(id: number): void {
    if (!this.hosts.delete(id)) return;
    this.recomputeTop();
  }

  /**
   * Called by the top host once its `<Toast>` instance is mounted. Moves the
   * visible toast onto it if another host was displaying it.
   */
  hostMounted(id: number): void {
    this.mountedHostId = id;
    const active = this.active;
    if (!active || active.hostId === id) return;

    let visibilityTime = active.visibilityTime;
    if (active.autoHide) {
      const remaining = active.visibilityTime - (this.now() - active.shownAt);
      if (remaining <= 0) {
        this.finish(active.token);
        return;
      }
      visibilityTime = Math.max(remaining, MIN_MOVED_VISIBILITY_MS);
    }

    active.hostId = id;
    active.shownAt = this.now();
    active.visibilityTime = visibilityTime;
    const token = active.token;
    this.options.show({
      ...active.params,
      visibilityTime,
      // onShow already ran when the toast first appeared.
      onShow: noop,
      onHide: () => this.finish(token),
    });
  }

  hostUnmounted(id: number): void {
    if (this.mountedHostId === id) {
      this.mountedHostId = null;
    }
  }

  /** Replacement for `Toast.show`. */
  show = (params: ToastShowParams): void => {
    this.tokenSeq += 1;
    const token = this.tokenSeq;
    this.active = {
      token,
      params,
      shownAt: this.now(),
      visibilityTime: params.visibilityTime ?? this.options.defaultVisibilityTime,
      autoHide: params.autoHide ?? this.options.defaultAutoHide,
      hostId: this.mountedHostId,
    };
    this.options.show({ ...params, onHide: () => this.finish(token) });
  };

  /** Replacement for `Toast.hide`. */
  hide = (): void => {
    const active = this.active;
    this.options.hide();
    // No mounted instance received the hide (e.g. between hosts): still end
    // the toast so it is not moved onto the next host.
    if (active && this.active === active) {
      this.finish(active.token);
    }
  };

  /** Ends the toast once; calls the caller's onHide at most one time. */
  private finish(token: number): void {
    const active = this.active;
    if (!active || active.token !== token) return;
    this.active = null;
    active.params.onHide?.();
  }

  private recomputeTop(): void {
    const next = this.pickTop();
    if (next === this.topHostId) return;
    this.topHostId = next;
    this.listeners.forEach((listener) => listener());
  }

  private pickTop(): number | null {
    let latestRoot: HostEntry | null = null;
    let latestModal: HostEntry | null = null;
    for (const host of this.hosts.values()) {
      if (host.kind === 'root') {
        if (!latestRoot || host.seq > latestRoot.seq) latestRoot = host;
      } else if (!latestModal || host.seq > latestModal.seq) {
        latestModal = host;
      }
    }
    if (!latestModal) return latestRoot ? latestRoot.id : null;

    // A nested modal is drawn above its parent even if it registered first.
    let top = latestModal;
    const visited = new Set<number>([top.id]);
    for (;;) {
      let child: HostEntry | null = null;
      for (const host of this.hosts.values()) {
        if (host.parentId === top.id && !visited.has(host.id) && (!child || host.seq > child.seq)) {
          child = host;
        }
      }
      if (!child) break;
      visited.add(child.id);
      top = child;
    }
    return top.id;
  }
}
