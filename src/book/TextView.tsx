import type { TextElement } from '@/domain/element'

type TextViewProps = {
  element: TextElement
  /** CSS pixels per page unit. */
  scale: number
}

export function TextView({ element, scale }: TextViewProps) {
  return (
    <div
      className="absolute whitespace-pre-wrap"
      style={{
        left: element.x * scale,
        top: element.y * scale,
        width: element.w * scale,
        height: element.h * scale,
        transform: `rotate(${element.rotation}deg)`,
        fontFamily: element.font === 'hand' ? 'var(--font-hand)' : 'var(--font-sans)',
        fontSize: element.size * scale,
        color: element.color,
        textAlign: element.align,
      }}
    >
      {element.text}
    </div>
  )
}
