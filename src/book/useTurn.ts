import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import {
  animate,
  motionValue,
  useReducedMotion,
  type AnimationPlaybackControls,
  type MotionValue,
} from 'motion/react'

/** Screen-space geometry of the book box, resolved at pointer-down time. */
export type TurnGeometry = {
  /** x of the spine. Sheets rotate around this line. */
  spineX: number
  /** Width of one page. */
  pageWidth: number
  top: number
  height: number
}

type UseTurnOptions = {
  /** Number of turnable sheets. Sheet `s` is turned when `s < turned`. */
  sheetCount: number
  turned: number
  onTurnedChange: (turned: number) => void
  /** Disables drag and click turning. Programmatic moves still animate. */
  locked?: boolean
  getGeometry: () => TurnGeometry | null
}

export type TurnEngine = {
  /** Lazily created per sheet; 0 = lying on the right stack, 1 = on the left. */
  progressFor: (sheet: number) => MotionValue<number>
  onPointerDown: (sheet: number, event: ReactPointerEvent<HTMLElement>) => void
  goTo: (turned: number) => void
  next: () => void
  prev: () => void
  reduced: boolean
}

const SPRING = { type: 'spring', stiffness: 120, damping: 20, mass: 0.8 } as const
const REDUCED = { duration: 0.2, ease: 'linear' } as const
const STAGGER = 0.07
/** Jumps further than this snap the intermediate sheets instead of fluttering them all. */
const MAX_ANIMATED = 3
const CLICK_MAX_MS = 400
const CLICK_MAX_PX = 6
/** Progress units per second; a flick past this completes or cancels the turn. */
const FLICK_VELOCITY = 1.2

type Drag = {
  sheet: number
  /** Distance from the spine where the page was grabbed. */
  grabDistance: number
  startX: number
  startY: number
  startedAt: number
  moved: boolean
  progress: MotionValue<number>
}

/**
 * Drives one `progress` MotionValue per sheet. Independent of how sheets are
 * drawn, so the two-page desktop book and the single-page phone book share it.
 */
export function useTurn({
  sheetCount,
  turned,
  onTurnedChange,
  locked = false,
  getGeometry,
}: UseTurnOptions): TurnEngine {
  const reduced = useReducedMotion() ?? false
  const values = useRef(new Map<number, MotionValue<number>>())
  const animations = useRef(new Map<number, AnimationPlaybackControls>())
  const turnedRef = useRef(turned)
  const previousTurned = useRef(turned)
  const drag = useRef<Drag | null>(null)
  const latest = useRef({ onTurnedChange, locked, getGeometry, reduced, sheetCount })
  latest.current = { onTurnedChange, locked, getGeometry, reduced, sheetCount }
  turnedRef.current = turned

  const progressFor = useCallback((sheet: number) => {
    let value = values.current.get(sheet)
    if (!value) {
      value = motionValue(sheet < turnedRef.current ? 1 : 0)
      values.current.set(sheet, value)
    }
    return value
  }, [])

  const animateTo = useCallback(
    (sheet: number, target: 0 | 1, delay = 0) => {
      animations.current.get(sheet)?.stop()
      const controls = animate(
        progressFor(sheet),
        target,
        latest.current.reduced ? { ...REDUCED, delay } : { ...SPRING, delay },
      )
      animations.current.set(sheet, controls)
    },
    [progressFor],
  )

  // React to the target changing: turn the sheets between the old and new count.
  useEffect(() => {
    const from = previousTurned.current
    previousTurned.current = turned
    if (from === turned) return

    const forward = turned > from
    const moving = forward
      ? range(from, turned)
      : range(turned, from).reverse()
    const target = forward ? 1 : 0
    const snapped = moving.slice(0, Math.max(0, moving.length - MAX_ANIMATED))
    const animated = moving.slice(snapped.length)

    for (const sheet of snapped) {
      animations.current.get(sheet)?.stop()
      progressFor(sheet).jump(target)
    }
    animated.forEach((sheet, i) => animateTo(sheet, target, i * STAGGER))

    // Sheets that were unmounted mid-way may hold stale values.
    for (const [sheet, value] of values.current) {
      if (moving.includes(sheet)) continue
      const resting = sheet < turned ? 1 : 0
      if (value.get() !== resting && !animations.current.get(sheet)?.state) {
        value.jump(resting)
      }
    }
  }, [turned, progressFor, animateTo])

  useEffect(
    () => () => {
      for (const controls of animations.current.values()) controls.stop()
    },
    [],
  )

  const goTo = useCallback((next: number) => {
    const clamped = Math.max(0, Math.min(latest.current.sheetCount, next))
    if (clamped !== turnedRef.current) latest.current.onTurnedChange(clamped)
  }, [])
  const next = useCallback(() => goTo(turnedRef.current + 1), [goTo])
  const prev = useCallback(() => goTo(turnedRef.current - 1), [goTo])

  const onPointerDown = useCallback(
    (sheet: number, event: ReactPointerEvent<HTMLElement>) => {
      if (latest.current.locked || event.button !== 0 || drag.current) return
      const current = turnedRef.current
      // Only the top sheet of either stack can be grabbed.
      if (sheet !== current && sheet !== current - 1) return
      const geometry = latest.current.getGeometry()
      if (!geometry) return

      const grabDistance = Math.abs(event.clientX - geometry.spineX)
      const alongPage = grabDistance / geometry.pageWidth
      const down = (event.clientY - geometry.top) / geometry.height
      const inEdge = alongPage >= 0.85
      const inCorner = alongPage >= 0.7 && (down <= 0.2 || down >= 0.8)
      if (!inEdge && !inCorner) return

      event.preventDefault()
      animations.current.get(sheet)?.stop()
      drag.current = {
        sheet,
        grabDistance: Math.max(grabDistance, 1),
        startX: event.clientX,
        startY: event.clientY,
        startedAt: performance.now(),
        moved: false,
        progress: progressFor(sheet),
      }
      document.body.style.cursor = 'grabbing'

      const spineX = geometry.spineX
      const onMove = (move: PointerEvent) => {
        const state = drag.current
        if (!state) return
        if (
          Math.abs(move.clientX - state.startX) > CLICK_MAX_PX ||
          Math.abs(move.clientY - state.startY) > CLICK_MAX_PX
        ) {
          state.moved = true
        }
        // The grabbed point sits at grabDistance * cos(pi * progress) from the
        // spine, so the page follows the finger instead of a linear mapping.
        const ratio = (move.clientX - spineX) / state.grabDistance
        state.progress.set(Math.acos(Math.max(-1, Math.min(1, ratio))) / Math.PI)
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        document.body.style.cursor = ''
        const state = drag.current
        drag.current = null
        if (!state) return

        const wasTurned = state.sheet < turnedRef.current
        if (!state.moved && performance.now() - state.startedAt < CLICK_MAX_MS) {
          animateTo(state.sheet, wasTurned ? 1 : 0)
          goTo(wasTurned ? state.sheet : state.sheet + 1)
          return
        }

        const p = state.progress.get()
        const v = state.progress.getVelocity()
        const target = v > FLICK_VELOCITY ? 1 : v < -FLICK_VELOCITY ? 0 : p > 0.5 ? 1 : 0
        animateTo(state.sheet, target)
        goTo(target === 1 ? state.sheet + 1 : state.sheet)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [progressFor, animateTo, goTo],
  )

  return { progressFor, onPointerDown, goTo, next, prev, reduced }
}

function range(start: number, end: number) {
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i)
}
