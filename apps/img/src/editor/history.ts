import { HISTORY_LIMIT, type EditorStore } from "./store";

/**
 * Collapses every store update made during a pointer gesture into one undo
 * step. Call at pointer-down: history tracking is paused for the duration and
 * the pre-gesture spreads are pushed back as a single entry at pointer-up.
 */
export function beginGesture(store: EditorStore) {
  const before = store.getState().spreads;
  store.temporal.getState().pause();

  return () => {
    const temporal = store.temporal.getState();
    temporal.resume();
    if (store.getState().spreads === before) return;
    store.temporal.setState({
      pastStates: [...temporal.pastStates, { spreads: before }].slice(-HISTORY_LIMIT),
      futureStates: [],
    });
  };
}
