import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { compositorClock } from '../compositor/client'
import {
  activeAudioClips,
  activeVideoClips,
  clipEnd,
  findClip,
  sourceTime,
  transitionTail,
} from './time'
import { resolveProp } from './keyframes'
import { effectiveProject } from './compound'
import {
  attachElement,
  resumeGraph,
  setMasterGain,
  setTrackBusFx,
  setTrackBusGain,
} from './audioGraph'
import type { Clip, Project } from '../types/project'

// Preview playback: one hidden/visible <video> per active clip (browser decodes,
// hardware accelerated — CONTEXT.md §3.2). The topmost video element is the master
// clock while healthy; otherwise the wall clock advances the playhead (gaps,
// reverse shuttle, element still seeking).

const DRIFT_TOLERANCE = 0.15 // s, while playing forward
const REVERSE_SEEK_INTERVAL = 0.1 // s between seeks when shuttling backwards

export type ElementMap = Map<string, HTMLVideoElement>

// Last swallowed per-tick error, for self-tests/diagnostics.
export let lastPlaybackError: string | null = null

// Clips whose media elements should be mounted: active now or starting soon
// (pre-decode upcoming cuts), plus a trailing window so outgoing clips can keep
// playing through cross transitions.
export function clipsToMount(pRaw: Project, t: number): Clip[] {
  const p = effectiveProject(pRaw)
  const out: Clip[] = []
  for (const tr of p.tracks) {
    for (const c of tr.clips) {
      if (!c.mediaId) continue
      if (c.start <= t + 1 && t - 1.5 < clipEnd(c)) out.push(c)
    }
  }
  return out
}

export function usePlaybackEngine(elements: React.RefObject<ElementMap>) {
  const lastReverseSeek = useRef(0)

  useEffect(() => {
    let raf = 0
    let lastNow = performance.now()

    const step = (now: number) => {
      const dt = Math.min(0.1, (now - lastNow) / 1000)
      lastNow = now
      const s = useStore.getState()
      const p = s.project

      if (s.playing) {
        // Clock authority (session 4): with the Rust compositor active, the
        // wall clock here is the anchor source — Rust free-runs from our
        // (t, playing, rate) samples, and media elements (audio duty only)
        // drift-correct against the same playhead in syncElements. The
        // element-as-master path survives only for the no-compositor
        // plain-browser fallback.
        const useElementMaster = !s.compositorActive
        const top = useElementMaster ? activeVideoClips(p, s.playhead)[0]?.clip : undefined
        const master = useElementMaster
          ? (top && elements.current?.get(top.id)) ||
            (activeAudioClips(p, s.playhead)
              .map((c) => elements.current?.get(c.id))
              .find(Boolean) ??
              null)
          : null
        const masterClip = master
          ? findClip(p, elementClipId(elements.current!, master)!)?.clip
          : null

        let ph: number
        const compClock =
          s.compositorActive &&
          Number.isFinite(compositorClock.t) &&
          performance.now() - compositorClock.at < 600 &&
          // `at` is RECEIPT time: the paused 1Hz keepalive rebroadcasts the
          // last frame, so after a reconnect (or around a big seek) a fresh
          // `at` can carry an ancient `t` — adopting it teleported playback
          // to end-of-media and instant-paused (pro-editor session, Phase 0
          // find). A frame wildly off the store playhead is stale, not
          // authoritative — same rule as the element-master guard below.
          Math.abs(compositorClock.t - s.playhead) < 1.0
        if (compClock) {
          // The compositor's frame header is the authoritative clock: immune
          // to rAF starvation (occluded windows crawled at ~0.4x otherwise).
          ph = compositorClock.t
        } else if (
          s.shuttle > 0 &&
          master &&
          masterClip &&
          !master.paused &&
          !master.seeking &&
          master.readyState >= 2
        ) {
          const mapped = masterClip.start + (master.currentTime - masterClip.in) / masterClip.speed
          // A wildly-off mapping means the element hasn't caught up to an external
          // seek yet — trust the store and let sync() correct the element instead.
          ph = Math.abs(mapped - s.playhead) < 0.5 ? mapped : s.playhead + dt * s.shuttle
          // Media elements stall on their last frame; push past the clip edge.
          if (ph >= clipEnd(masterClip) - 0.002) ph = clipEnd(masterClip) + 0.0001
        } else {
          ph = s.playhead + dt * s.shuttle
        }

        if (s.shuttle > 0 && ph >= p.duration) {
          s.enginePlayhead(p.duration)
          s.pause()
        } else if (s.shuttle < 0 && ph <= 0) {
          s.enginePlayhead(0)
          s.pause()
        } else {
          s.enginePlayhead(ph)
        }
      }

      syncElements(elements.current!, lastReverseSeek)
    }

    let lastStep = 0
    const loop = (now: number) => {
      lastStep = now
      // One bad tick must never kill playback (foundation, Phase 3 find:
      // an exception here froze pan/master updates silently).
      try {
        step(now)
      } catch (e) {
        lastPlaybackError = String(e instanceof Error ? (e.stack ?? e.message) : e)
        console.error('playback step failed:', e)
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    // rAF is suspended while the window is hidden/occluded; a coarse interval
    // keeps playback lifecycle (clip boundaries, element start/stop) moving so
    // audio continues correctly in the background. Yields whenever rAF is alive.
    const fallback = window.setInterval(() => {
      const now = performance.now()
      if (now - lastStep > 400) {
        try {
          step(now)
        } catch (e) {
          lastPlaybackError = String(e instanceof Error ? (e.stack ?? e.message) : e)
        }
      }
    }, 250)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(fallback)
    }
  }, [elements])
}

function elementClipId(map: ElementMap, el: HTMLVideoElement): string | null {
  for (const [id, e] of map) if (e === el) return id
  return null
}

function syncElements(map: ElementMap, lastReverseSeek: React.MutableRefObject<number>) {
  const s = useStore.getState()
  const p = effectiveProject(s.project)
  const t = s.playhead
  const forward = s.playing && s.shuttle > 0
  const nowS = performance.now() / 1000
  // Master output gain + graph wake-up (foundation, Phase 3).
  setMasterGain(p.masterVolume ?? 1)
  if (s.playing || s.scrubbing) resumeGraph()

  for (const [clipId, el] of map) {
    const found = findClip(p, clipId)
    if (!found) {
      el.pause()
      continue
    }
    const clip = found.clip
    // Extend activity through the next clip's cross transition (media handle).
    const activeEnd = clipEnd(clip) + transitionTail(p, clip)
    const active = clip.start <= t && t < activeEnd
    const target = sourceTime(clip, Math.max(clip.start, Math.min(t, activeEnd)))

    if (!active) {
      if (!el.paused) el.pause()
      // Pre-seek upcoming clips so they start instantly.
      if (Math.abs(el.currentTime - target) > 0.05 && !el.seeking) el.currentTime = target
      continue
    }

    // Keyframe times are clip-relative in TIMELINE seconds (t - clip.start).
    // Track mute/solo (session 9, Phase 3): solo is scoped per kind; a muted
    // or un-solo'd track zeroes its clips' audio. Hidden stays audio-neutral
    // (Premiere eye semantics: video only).
    const anySolo = p.tracks.some((tr) => tr.kind === found.track.kind && tr.solo)
    const ramped = clip.keyframes.some((k) => k.prop === 'speed') // ramps are video-only
    const trackGain =
      found.track.muted || (anySolo && !found.track.solo) || ramped || clip.disabled ? 0 : 1
    const vol = resolveProp(clip, 'volume', t - clip.start) * trackGain
    el.volume = Math.min(1, Math.max(0, vol))
    el.muted = vol <= 0 || (s.playing && s.shuttle < 0)
    // Route through the Web Audio tail: pan → track bus (mixer fader, can
    // exceed 1.0 — element.volume clamps) → master + meters.
    attachElement(el, Math.max(-1, Math.min(1, clip.pan ?? 0)), found.track.id, clip.effects)
    setTrackBusGain(found.track.id, found.track.gain ?? 1)
    setTrackBusFx(found.track.id, found.track.effects ?? [])
    el.playbackRate = Math.min(
      16,
      Math.max(0.0625, clip.speed * Math.max(0.0625, Math.abs(s.shuttle))),
    )

    if (forward) {
      if (Math.abs(el.currentTime - target) > DRIFT_TOLERANCE && !el.seeking)
        el.currentTime = target
      if (el.paused) {
        el.play().catch(() => {
          // Autoplay refused (browser policy) — surface as paused state.
          useStore.getState().pause()
        })
      }
    } else {
      // Audio scrubbing (foundation, Phase 2): while the playhead is being
      // dragged, let audible elements run so the user HEARS the material —
      // the constant re-seeks below produce the classic scrub chatter.
      const scrubAudio = s.scrubbing && !s.playing && vol > 0
      if (scrubAudio) {
        if (el.paused) void el.play().catch(() => {})
      } else if (!el.paused) el.pause()
      // Paused: exact frame. Reverse shuttle: throttled seek stepping.
      // ponytail: reverse playback via seeks is choppy by nature; <video> can't
      // play backwards — the native compositor session owns smooth reverse.
      const isReverse = s.playing && s.shuttle < 0
      const threshold = isReverse ? 0.001 : 1 / (p.canvas.fps * 2)
      const throttleOk = !isReverse || nowS - lastReverseSeek.current > REVERSE_SEEK_INTERVAL
      if (Math.abs(el.currentTime - target) > threshold && !el.seeking && throttleOk) {
        el.currentTime = target
        if (isReverse) lastReverseSeek.current = nowS
      }
    }
  }
}
