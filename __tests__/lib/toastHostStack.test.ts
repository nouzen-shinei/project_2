// Unit tests for lib/toastHostStack.ts: which host draws the toast on
// iOS/Android, and how a visible toast moves when modals open and close.
import { MIN_MOVED_VISIBILITY_MS, ToastHostStack } from '../../lib/toastHostStack';

function setup() {
  let now = 1_000;
  const show = jest.fn();
  const hide = jest.fn();
  const stack = new ToastHostStack({
    show,
    hide,
    defaultVisibilityTime: 4000,
    defaultAutoHide: true,
    now: () => now,
  });
  const advance = (ms: number) => {
    now += ms;
  };
  /** Simulates the host's effects after it becomes top and mounts <Toast>. */
  const settle = () => {
    const top = stack.getTopHostId();
    if (top !== null) stack.hostMounted(top);
  };
  return { stack, show, hide, advance, settle };
}

describe('ToastHostStack top host', () => {
  it('uses the root host when no modal is open', () => {
    const { stack } = setup();
    const root = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    expect(stack.getTopHostId()).toBe(root);
  });

  it('puts an open modal above the root, even a root host that registered later', () => {
    const { stack } = setup();
    const modal = stack.nextHostId();
    const root = stack.nextHostId();
    stack.registerHost(modal, 'modal', null);
    stack.registerHost(root, 'root', null);
    expect(stack.getTopHostId()).toBe(modal);
  });

  it('picks the most recently opened modal among siblings', () => {
    const { stack } = setup();
    const root = stack.nextHostId();
    const a = stack.nextHostId();
    const b = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    stack.registerHost(a, 'modal', null);
    stack.registerHost(b, 'modal', null);
    expect(stack.getTopHostId()).toBe(b);
    stack.unregisterHost(b);
    expect(stack.getTopHostId()).toBe(a);
    stack.unregisterHost(a);
    expect(stack.getTopHostId()).toBe(root);
  });

  it('keeps a nested modal above its parent when the child registers first', () => {
    const { stack } = setup();
    const parent = stack.nextHostId();
    const child = stack.nextHostId();
    const grandchild = stack.nextHostId();
    // Same commit: React runs child effects before parent effects.
    stack.registerHost(grandchild, 'modal', child);
    stack.registerHost(child, 'modal', parent);
    stack.registerHost(parent, 'modal', null);
    expect(stack.getTopHostId()).toBe(grandchild);
  });

  it('lets a sibling opened later sit above an older nested modal', () => {
    const { stack } = setup();
    const a = stack.nextHostId();
    const nested = stack.nextHostId();
    const b = stack.nextHostId();
    stack.registerHost(a, 'modal', null);
    stack.registerHost(nested, 'modal', a);
    stack.registerHost(b, 'modal', null);
    expect(stack.getTopHostId()).toBe(b);
  });

  it('notifies subscribers only when the top host changes', () => {
    const { stack } = setup();
    const listener = jest.fn();
    stack.subscribe(listener);
    const root = stack.nextHostId();
    const modal = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    stack.registerHost(modal, 'modal', null);
    stack.registerHost(modal, 'modal', null);
    expect(listener).toHaveBeenCalledTimes(2);
    stack.unregisterHost(999);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('ToastHostStack moving a visible toast', () => {
  it('shows a toast fired right before a modal closes on the root for its remaining time', () => {
    const { stack, show, advance, settle } = setup();
    const root = stack.nextHostId();
    const modal = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    stack.registerHost(modal, 'modal', null);
    settle();

    const onShow = jest.fn();
    stack.show({ type: 'success', text1: 'Notice posted', onShow });
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0]).toMatchObject({ text1: 'Notice posted', onShow });

    advance(200);
    stack.unregisterHost(modal); // modal closes
    expect(stack.getTopHostId()).toBe(root);
    settle();

    expect(show).toHaveBeenCalledTimes(2);
    const moved = show.mock.calls[1][0];
    expect(moved.text1).toBe('Notice posted');
    expect(moved.type).toBe('success');
    expect(moved.visibilityTime).toBe(3800);
    expect(moved.onShow).not.toBe(onShow);
  });

  it('moves a toast showing on the root into a modal that opens over it', () => {
    const { stack, show, advance, settle } = setup();
    const root = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    settle();
    stack.show({ type: 'error', text1: 'Failed to post notice', visibilityTime: 3000 });
    advance(1000);

    const modal = stack.nextHostId();
    stack.registerHost(modal, 'modal', null);
    stack.hostUnmounted(root);
    settle();

    expect(show).toHaveBeenCalledTimes(2);
    expect(show.mock.calls[1][0]).toMatchObject({ text1: 'Failed to post notice', visibilityTime: 2000 });
  });

  it('re-shows when Toast.show ran while no host instance was mounted', () => {
    const { stack, show, settle } = setup();
    const root = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    stack.show({ text1: 'early' });
    settle();
    expect(show).toHaveBeenCalledTimes(2);
  });

  it('does not re-show on the host that is already displaying the toast', () => {
    const { stack, show, settle } = setup();
    const root = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    settle();
    stack.show({ text1: 'hello' });
    settle();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('keeps a moved toast up for a minimum time so it does not flash', () => {
    const { stack, show, advance, settle } = setup();
    const root = stack.nextHostId();
    const modal = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    stack.registerHost(modal, 'modal', null);
    settle();
    stack.show({ text1: 'late' });
    advance(3900);
    stack.unregisterHost(modal);
    settle();
    expect(show.mock.calls[1][0].visibilityTime).toBe(MIN_MOVED_VISIBILITY_MS);
  });

  it('drops a toast whose time ran out between hosts and calls onHide once', () => {
    const { stack, show, advance, settle } = setup();
    const root = stack.nextHostId();
    const modal = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    stack.registerHost(modal, 'modal', null);
    settle();
    const onHide = jest.fn();
    stack.show({ text1: 'expired', onHide });
    advance(5000);
    stack.unregisterHost(modal);
    settle();
    expect(show).toHaveBeenCalledTimes(1);
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('keeps autoHide: false toasts open indefinitely when moved', () => {
    const { stack, show, advance, settle } = setup();
    const root = stack.nextHostId();
    const modal = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    stack.registerHost(modal, 'modal', null);
    settle();
    stack.show({ text1: 'sticky', autoHide: false });
    advance(60_000);
    stack.unregisterHost(modal);
    settle();
    expect(show).toHaveBeenCalledTimes(2);
    expect(show.mock.calls[1][0].autoHide).toBe(false);
  });

  it('only moves the latest toast', () => {
    const { stack, show, settle } = setup();
    const root = stack.nextHostId();
    const modal = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    stack.registerHost(modal, 'modal', null);
    settle();
    stack.show({ text1: 'first' });
    stack.show({ text1: 'second' });
    stack.unregisterHost(modal);
    settle();
    expect(show).toHaveBeenCalledTimes(3);
    expect(show.mock.calls[2][0].text1).toBe('second');
  });
});

describe('ToastHostStack hide and onHide', () => {
  it('calls the caller onHide once when the library hides the toast', () => {
    const { stack, show, settle } = setup();
    const root = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    settle();
    const onHide = jest.fn();
    stack.show({ text1: 'x', onHide });
    const libraryOnHide = show.mock.calls[0][0].onHide as () => void;
    libraryOnHide();
    libraryOnHide(); // library re-fires the stale onHide on a later Toast.hide()
    expect(onHide).toHaveBeenCalledTimes(1);
  });

  it('does not move a toast that was already hidden', () => {
    const { stack, show, settle } = setup();
    const root = stack.nextHostId();
    const modal = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    stack.registerHost(modal, 'modal', null);
    settle();
    stack.show({ text1: 'x' });
    (show.mock.calls[0][0].onHide as () => void)();
    stack.unregisterHost(modal);
    settle();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('ends the toast on Toast.hide even if no instance received it', () => {
    const { stack, show, hide, settle } = setup();
    const root = stack.nextHostId();
    stack.registerHost(root, 'root', null);
    const onHide = jest.fn();
    stack.show({ text1: 'x', onHide });
    stack.hide();
    expect(hide).toHaveBeenCalledTimes(1);
    expect(onHide).toHaveBeenCalledTimes(1);
    settle();
    expect(show).toHaveBeenCalledTimes(1);
  });
});
