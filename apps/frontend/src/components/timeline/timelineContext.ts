import { createContext, useContext } from 'react'

export interface LaneRect {
  trackId: string
  kind: 'video' | 'audio'
  top: number
  bottom: number
}

export interface TimelineCtx {
  pxPerSec: number
  // Convert a pointer clientX to timeline seconds (accounts for scroll).
  xToTime: (clientX: number) => number
  scrollEl: () => HTMLDivElement | null
  // Lane rects in client coordinates, captured on demand for drag targeting.
  captureLanes: () => LaneRect[]
}

export const TimelineContext = createContext<TimelineCtx | null>(null)

export function useTimeline(): TimelineCtx {
  const ctx = useContext(TimelineContext)
  if (!ctx) throw new Error('useTimeline outside TimelineContext')
  return ctx
}
