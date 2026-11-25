/**
 * In-app signal that the set of notices changed (one was posted, deleted, or a
 * live listener saw one appear or disappear). Notice counts listen to it to
 * refresh, so they stay correct without keeping every notice in memory.
 */
type Listener = () => void;

const listeners = new Set<Listener>();

export const noticeEvents = {
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  emitChanged(): void {
    listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // A failing listener must not stop the others.
      }
    });
  },
};
