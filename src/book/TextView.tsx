import { useRef, type KeyboardEvent, type Ref } from 'react'
import type { TextElement } from '@/domain/element'

type TextViewProps = {
  element: TextElement
  /** CSS pixels per page unit. */
  scale: number
  ref?: Ref<HTMLDivElement>
  /** Inline editing: the node becomes contentEditable until commit or cancel. */
  editing?: { onCommit: (text: string) => void; onCancel: () => void }
}

export function TextView({ element, scale, ref, editing }: TextViewProps) {
  // While editing, React keeps rendering the text from before the edit began,
  // so it never overwrites what the user is typing in the contentEditable.
  const snapshot = useRef<string | null>(null)
  if (editing && snapshot.current === null) snapshot.current = element.text
  if (!editing) snapshot.current = null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!editing) return
    if (event.key === 'Escape') {
      event.preventDefault()
      editing.onCancel()
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }

  return (
    <div
      ref={ref}
      data-element={element.id}
      className="absolute leading-tight whitespace-pre-wrap outline-none"
      contentEditable={editing ? 'plaintext-only' : undefined}
      suppressContentEditableWarning
      onBlur={editing ? (event) => editing.onCommit(event.currentTarget.innerText) : undefined}
      onKeyDown={onKeyDown}
      style={{
        left: element.x * scale,
        top: element.y * scale,
        width: element.w * scale,
        minHeight: element.h * scale,
        transform: `rotate(${element.rotation}deg)`,
        fontFamily: element.font === 'hand' ? 'var(--font-hand)' : 'var(--font-sans)',
        fontSize: element.size * scale,
        color: element.color,
        textAlign: element.align,
        cursor: editing ? 'text' : undefined,
      }}
    >
      {editing ? snapshot.current : element.text}
    </div>
  )
}
