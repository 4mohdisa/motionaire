import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// THE floating-panel primitive (foundation session, Phase 0). Every menu,
// dropdown, and context menu renders through this — never ad-hoc absolute
// positioning. Guarantees, in order:
//   1. Portal at document.body — no ancestor overflow can ever clip it.
//   2. Collision flip — opens upward when there's no room below (and vice
//      versa), choosing the side with more room when neither fits.
//   3. Viewport-edge shifting on the cross axis.
//   4. max-height with internal scroll as the final fallback.

const MARGIN = 8 // minimum gap to the viewport edge
const GAP = 4 // gap between anchor and panel

export interface PopoverProps {
  // Anchor: a trigger element's rect (dropdowns) or a cursor point (context menus).
  anchorRect?: DOMRect
  point?: { x: number; y: number }
  alignRight?: boolean
  onClose: () => void
  children: React.ReactNode
  className?: string
}

export function Popover({
  anchorRect,
  point,
  alignRight,
  onClose,
  children,
  className,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{
    left: number
    top: number
    maxHeight: number
    visible: boolean
  }>({ left: -9999, top: -9999, maxHeight: 9999, visible: false })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const place = () => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const panel = el.getBoundingClientRect()
      const ax = point?.x ?? (alignRight ? (anchorRect?.right ?? 0) : (anchorRect?.left ?? 0))
      const topEdge = point?.y ?? anchorRect?.bottom ?? 0
      const bottomEdge = point?.y ?? anchorRect?.top ?? 0

      // Vertical: prefer below; flip above when it doesn't fit and there's
      // more room above; clamp + scroll when neither side fits fully.
      const roomBelow = vh - MARGIN - (topEdge + GAP)
      const roomAbove = bottomEdge - GAP - MARGIN
      let top: number
      let maxHeight: number
      if (panel.height <= roomBelow || roomBelow >= roomAbove) {
        top = topEdge + GAP
        maxHeight = Math.max(48, roomBelow)
      } else {
        maxHeight = Math.max(48, roomAbove)
        top = Math.max(MARGIN, bottomEdge - GAP - Math.min(panel.height, maxHeight))
      }

      // Horizontal: align to the requested edge, then shift into the viewport.
      let left = alignRight && anchorRect ? ax - panel.width : ax
      left = Math.min(left, vw - MARGIN - panel.width)
      left = Math.max(MARGIN, left)

      setPos({ left, top, maxHeight, visible: true })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [anchorRect, point, alignRight])

  useLayoutEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onBlur = () => onClose()
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onEsc)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onEsc)
      window.removeEventListener('blur', onBlur)
    }
  }, [onClose])

  return createPortal(
    <div
      ref={ref}
      className={`popover${className ? ` ${className}` : ''}`}
      style={{
        left: pos.left,
        top: pos.top,
        maxHeight: pos.maxHeight,
        visibility: pos.visible ? 'visible' : 'hidden',
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  )
}
