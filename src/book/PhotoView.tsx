import type { PhotoElement } from '@/domain/element'
import { photoUrl } from '@/lib/image'

type PhotoViewProps = {
  element: PhotoElement
  /** CSS pixels per page unit. */
  scale: number
}

// phase 2: frame styles (polaroid, corners, tape) and the layered lift shadow.
export function PhotoView({ element, scale }: PhotoViewProps) {
  return (
    <img
      src={photoUrl(element.photoId, 'display')}
      alt=""
      draggable={false}
      className="absolute block object-cover select-none"
      style={{
        left: element.x * scale,
        top: element.y * scale,
        width: element.w * scale,
        height: element.h * scale,
        transform: `rotate(${element.rotation}deg)`,
      }}
    />
  )
}
