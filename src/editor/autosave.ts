import * as spreadFns from '@/server/fns/spreads'
import type { EditorState, EditorStore } from './store'
import type { Spread } from '@/server/db/schema'

const DEBOUNCE_MS = 800

/**
 * Persists store edits. Element changes are detected by reference and debounced
 * per spread; structural changes (insert, delete, reorder) go out immediately.
 * Returns an unsubscribe function.
 */
export function attachAutosave(store: EditorStore) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  let inFlight = 0

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

  const queueElements = (spread: Spread) => {
    clearTimeout(timers.get(spread.id))
    timers.set(
      spread.id,
      setTimeout(() => {
        timers.delete(spread.id)
        run(
          spreadFns.saveElements({
            data: { spreadId: spread.id, elements: spread.elements },
          }),
        )
      }, DEBOUNCE_MS),
    )
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
    if (ids.join() !== prevIds.join()) run(syncStructure(state, prevIds))
  })

  return () => {
    unsubscribe()
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
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

  for (const [index, id] of ids.entries()) {
    if (before.has(id)) continue
    await spreadFns.insert({
      data: { albumId: state.album.id, afterPosition: index - 1, id },
    })
  }

  await spreadFns.reorder({
    data: { albumId: state.album.id, orderedIds: ids },
  })
}
