import { useEffect } from 'react'
import { Book, PageElements, type PageLayout } from '@/book/Book'
import type { PageSide } from '@/domain/element'
import type { Spread } from '@/server/db/schema'
import { EditablePage } from './EditablePage'
import { Filmstrip } from './Filmstrip'
import { PhotoLibrary } from './PhotoLibrary'
import { useEditor, useEditorStore } from './store'
import { Toolbar } from './Toolbar'

const NUDGE = 5
const NUDGE_FAST = 25

type EditorProps = {
  /** Phones flip through only; the editor never mounts there. */
  canEdit: boolean
}

/** The book plus everything edit mode adds around and on top of it. */
export function Editor({ canEdit }: EditorProps) {
  const album = useEditor((state) => state.album)
  const spreads = useEditor((state) => state.spreads)
  const current = useEditor((state) => state.current)
  const mode = useEditor((state) => state.mode)
  const setCurrent = useEditor((state) => state.setCurrent)
  const editing = canEdit && mode === 'edit'
  const spread = spreads[current]

  useEditorKeys(canEdit)

  // The open spread is drawn by the overlay instead, so its paper stays blank.
  const renderPage = editing
    ? (s: Spread, side: PageSide, layout: PageLayout) =>
        s.id === spread?.id ? null : (
          <PageElements elements={s.elements} side={side} scale={layout.scale} />
        )
    : undefined

  return (
    <>
      <div className="flex min-h-0 flex-1 px-6 pb-16">
        <Book
          title={album.title}
          cover={album.cover}
          spreads={spreads}
          current={current}
          onCurrentChange={setCurrent}
          locked={editing}
          renderPage={renderPage}
          overlay={
            editing && spread
              ? (layout: PageLayout) => (
                  <>
                    <EditablePage spread={spread} side="left" layout={layout} />
                    <EditablePage spread={spread} side="right" layout={layout} />
                  </>
                )
              : undefined
          }
        />
      </div>
      {editing ? <Toolbar /> : null}
      {canEdit ? (
        <>
          <PhotoLibrary />
          <Filmstrip />
        </>
      ) : null}
    </>
  )
}

/** Global shortcuts. Runs in the capture phase so it can pre-empt the book's arrow keys. */
function useEditorKeys(canEdit: boolean) {
  const store = useEditorStore()

  useEffect(() => {
    if (!canEdit) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditable(event.target)) return
      const state = store.getState()
      const meta = event.metaKey || event.ctrlKey

      if (!meta && event.key.toLowerCase() === 'e' && !event.altKey) {
        event.preventDefault()
        state.setMode(state.mode === 'edit' ? 'view' : 'edit')
        return
      }
      if (state.mode !== 'edit') return

      if (meta && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        const temporal = store.temporal.getState()
        if (event.shiftKey) temporal.redo()
        else temporal.undo()
        return
      }

      const spread = state.spreads[state.current]
      const selected = spread?.elements.find((el) => el.id === state.selection)
      if (!spread || !selected) return

      if (event.key === 'Escape') {
        state.select(null)
        return
      }
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault()
        state.removeElement(spread.id, selected.id)
        return
      }
      if (meta && (event.key === ']' || event.key === '[')) {
        event.preventDefault()
        const forward = event.key === ']'
        state.reorderElement(
          spread.id,
          selected.id,
          event.shiftKey ? (forward ? 'front' : 'back') : forward ? 'forward' : 'backward',
        )
        return
      }
      const nudge = ARROWS[event.key]
      if (nudge && !meta) {
        event.preventDefault()
        event.stopPropagation()
        const step = event.shiftKey ? NUDGE_FAST : NUDGE
        state.updateElement(spread.id, selected.id, {
          x: selected.x + nudge.x * step,
          y: selected.y + nudge.y * step,
        })
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [store, canEdit])
}

const ARROWS: Record<string, { x: number; y: number }> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
}

function isEditable(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))
  )
}
