import type { Element } from '@/domain/element'
import * as spreadFns from '@/server/fns/spreads'
import type { EditorState, EditorStore } from './store'
import type { Spread } from '@/server/db/schema'

const DEBOUNCE_MS = 800

/**
 * Persists store edits. Element changes are detected by reference and debounced
 * per spread; structural changes (insert, delete, reorder) go out immediately.
 * Pending saves are flushed when the editor unmounts or the tab goes away, so
 * navigating inside the debounce window never drops an edit.
 * Returns an unsubscribe function.
 */
export function attachAutosave(store: EditorStore) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const pending = new Map<string, Element[]>()
  let inFlight = 0
  // Structural saves rewrite every position of the album, so they must not
  // overlap: each one runs against the rows the previous one left behind.
  let structural: Promise<unknown> = Promise.resolve()

  const settle = (ok: boolean) => {
    inFlight -= 1
    if (!ok) store.getState().setSaveStatus('error')
    else if (inFlight === 0) store.getState().setSaveStatus('saved')
  }

  const run = (work: Promise<unknown>) => {
    inFlight += 1
    store.getState().setSaveStatus('saving')
    work.then(
      () => settle(true),
      () => settle(false),
    )
  }

  /** Fires the request without awaiting it, so it survives a synchronous unmount. */
  const flush = (spreadId: string) => {
    const elements = pending.get(spreadId)
    clearTimeout(timers.get(spreadId))
    timers.delete(spreadId)
    pending.delete(spreadId)
    if (!elements) return
    run(spreadFns.saveElements({ data: { spreadId, elements } }))
  }

  const flushAll = () => {
    for (const spreadId of [...pending.keys()]) flush(spreadId)
  }

  const queueElements = (spread: Spread) => {
    pending.set(spread.id, spread.elements)
    clearTimeout(timers.get(spread.id))
    timers.set(spread.id, setTimeout(() => flush(spread.id), DEBOUNCE_MS))
  }

  const unsubscribe = store.subscribe((state, prev) => {
    if (state.spreads === prev.spreads) return

    const prevById = new Map(prev.spreads.map((s) => [s.id, s]))
    for (const spread of state.spreads) {
      const before = prevById.get(spread.id)
      if (before && before.elements !== spread.elements) queueElements(spread)
    }

    const ids = state.spreads.map((s) => s.id)
    const prevIds = prev.spreads.map((s) => s.id)
    if (ids.join() !== prevIds.join()) {
      const sync = () => syncStructure(state, prevIds)
      structural = structural.then(sync, sync)
      run(structural)
    }
  })

  window.addEventListener('beforeunload', flushAll)

  return () => {
    unsubscribe()
    window.removeEventListener('beforeunload', flushAll)
    flushAll()
  }
}

async function syncStructure(state: EditorState, prevIds: string[]) {
  const ids = state.spreads.map((s) => s.id)
  const before = new Set(prevIds)
  const after = new Set(ids)

  await Promise.all(
    prevIds
      .filter((id) => !after.has(id))
      .map((id) => spreadFns.remove({ data: { spreadId: id } })),
  )

  // Re-inserting carries the elements, so undoing a spread delete restores it whole.
  for (const [index, spread] of state.spreads.entries()) {
    if (before.has(spread.id)) continue
    await spreadFns.insert({
      data: {
        albumId: state.album.id,
        afterPosition: index - 1,
        id: spread.id,
        elements: spread.elements,
      },
    })
  }

  await spreadFns.reorder({
    data: { albumId: state.album.id, orderedIds: ids },
  })
}
