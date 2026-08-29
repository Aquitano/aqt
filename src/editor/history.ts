import type { EditorStore } from './store'

/**
 * Collapses every store update made during a pointer gesture into one undo
 * step. Call at pointer-down; the returned function runs at pointer-up and
 * drops all but the first history entry the gesture produced.
 */
export function beginGesture(store: EditorStore) {
  const before = store.temporal.getState().pastStates.length
  return () => {
    const temporal = store.temporal.getState()
    if (temporal.pastStates.length > before + 1) {
      store.temporal.setState({ pastStates: temporal.pastStates.slice(0, before + 1) })
    }
  }
}
