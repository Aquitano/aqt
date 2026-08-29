import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type PageSurfaceProps = {
  /** Rendered page size in CSS pixels. Pages are always square. */
  sizePx: number
  side: 'left' | 'right'
  children?: ReactNode
  className?: string
}

// phase 2: grain (feTurbulence), gutter gradient and the hairline inner edge.
export function PageSurface({
  sizePx,
  side,
  children,
  className,
}: PageSurfaceProps) {
  return (
    <div
      className={cn(
        'relative overflow-hidden bg-[oklch(0.985_0.006_85)]',
        side === 'left' ? 'rounded-l-sm' : 'rounded-r-sm',
        className,
      )}
      style={{ width: sizePx, height: sizePx }}
    >
      {children}
    </div>
  )
}
