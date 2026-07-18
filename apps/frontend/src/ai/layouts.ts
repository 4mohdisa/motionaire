import { useStore } from '../state/store'
import { clipEnd, findClip, isActiveAt } from '../engine/time'
import { resolveProp } from '../engine/keyframes'
import { registerTool, type ToolResult } from './tools'
import type { Clip, Ease, Project } from '../types/project'

// set_layout (Run 1, Phase 5a — CONTEXT §2.2's high-leverage abstraction).
// ONE call emits coordinated keyframes across every affected video track:
// each affected clip gets a keyframe PAIR per property — current resolved
// value at `at`, target at `at+duration` — so the move animates from
// wherever things are now. Layouts: fullscreen | pip | side_by_side |
// top_bottom | grid | hidden.
//
// This is still "the AI edits the timeline": nothing here touches pixels —
// only keyframes on the same properties a human drags in the panel.

interface Target {
  clip: Clip
  props: Record<string, number>
}

const st = () => useStore.getState()
const proj = (): Project => st().project

// Drawn size at scale 1: the compositor object-fit:contains the source into
// the canvas. All layout math flows from this.
function fitted(clip: Clip): { w: number; h: number } {
  const p = proj()
  const asset = p.media.find((m) => m.id === clip.mediaId)
  const sw = asset?.width ?? p.canvas.width
  const sh = asset?.height ?? p.canvas.height
  const fit = Math.min(p.canvas.width / sw, p.canvas.height / sh)
  return { w: sw * fit, h: sh * fit }
}

// Resolve a track reference: real track id, clip id, or the heuristics
// "auto-cam" (smallest active source = the webcam) / "auto-screen".
function resolveTrack(ref: string, at: number): string | null {
  const p = proj()
  if (p.tracks.some((t) => t.id === ref)) return ref
  const byClip = findClip(p, ref)
  if (byClip) return byClip.track.id
  if (ref === 'auto-cam' || ref === 'auto-screen') {
    const candidates = p.tracks
      .filter((t) => t.kind === 'video')
      .map((t) => {
        const active = t.clips.find((c) => c.kind === 'video' && isActiveAt(c, at))
        if (!active) return null
        const asset = p.media.find((m) => m.id === active.mediaId)
        return { trackId: t.id, area: (asset?.width ?? 1e9) * (asset?.height ?? 1e9) }
      })
      .filter(Boolean) as { trackId: string; area: number }[]
    if (candidates.length < 1) return null
    candidates.sort((a, b) => a.area - b.area)
    return ref === 'auto-cam' ? candidates[0].trackId : candidates[candidates.length - 1].trackId
  }
  return null
}

function activeVideoClipOn(trackId: string, at: number): Clip | null {
  const t = proj().tracks.find((x) => x.id === trackId)
  return t?.clips.find((c) => c.kind === 'video' && isActiveAt(c, at)) ?? null
}

const LAYOUT_PROPS = [
  'transform.scale',
  'transform.x',
  'transform.y',
  'transform.cornerRadius',
  'transform.opacity',
]

// generate_video (Phase 6c): the chat can start a generation job. The turn
// returns immediately (generation is minutes-long); placement on arrival is
// handled by the job's placeAt. COST HONESTY: the tool description tells
// the model to warn the user, and the diff names the credit spend.
export function installGenerateTool(): void {
  registerTool(
    {
      name: 'generate_video',
      description:
        "Generate a video clip from a text prompt with the user's configured provider (THIS SPENDS THE USER'S API CREDITS — only call when the user explicitly asked to generate). Optional place_at drops it on the timeline when ready. Returns immediately; the clip lands in the media bin after a few minutes.",
      schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string' },
          duration_secs: { type: 'number' },
          aspect: { type: 'string' },
          place_at: { type: 'number' },
        },
        required: ['prompt'],
      },
    },
    (a): ToolResult => {
      const prompt = typeof a.prompt === 'string' ? a.prompt.trim() : ''
      if (!prompt) return { ok: false, error: 'prompt required' }
      const s = useStore.getState()
      const provider = s.prefs.aiVideoProvider === 'none' ? 'mockgen' : s.prefs.aiVideoProvider
      void import('../persistence/genManager').then((m) =>
        m.startGeneration({
          prompt,
          durationSecs: typeof a.duration_secs === 'number' ? a.duration_secs : 5,
          aspect: typeof a.aspect === 'string' ? a.aspect : '16:9',
          placeAt: typeof a.place_at === 'number' ? a.place_at : undefined,
        }),
      )
      return {
        ok: true,
        diff: `Started ${provider} generation: "${prompt.slice(0, 40)}"${typeof a.place_at === 'number' ? ` → will land at ${a.place_at}s` : ' → media bin'}${provider === 'mockgen' ? '' : ' (uses API credits)'}`,
      }
    },
  )
}

export function installLayoutTool(): void {
  registerTool(
    {
      name: 'set_layout',
      description:
        'Arrange video tracks with ONE call that emits coordinated keyframes. layout: fullscreen | pip | side_by_side | top_bottom | grid | hidden. track: a track id, clip id, or "auto-cam"/"auto-screen". pip params: corner (top_left|top_right|bottom_left|bottom_right), scale (0..1 of full size), radius (px), margin (px). at = when the move starts (timeline seconds), duration = how long the move takes. To return to normal later, call again with layout "fullscreen" at the later time.',
      schema: {
        type: 'object',
        properties: {
          layout: { type: 'string' },
          track: { type: 'string' },
          corner: { type: 'string' },
          scale: { type: 'number' },
          radius: { type: 'number' },
          margin: { type: 'number' },
          at: { type: 'number' },
          duration: { type: 'number' },
          ease: { type: 'string' },
        },
        required: ['layout', 'at'],
      },
    },
    (a): ToolResult => {
      const p = proj()
      const at = typeof a.at === 'number' ? a.at : NaN
      const duration = typeof a.duration === 'number' && a.duration > 0 ? a.duration : 1.0
      if (!Number.isFinite(at)) return { ok: false, error: 'at must be seconds' }
      const layout = String(a.layout)
      const ease: Ease = (['linear', 'easeIn', 'easeOut', 'easeInOut', 'spring'] as const).includes(
        String(a.ease) as Ease,
      )
        ? (String(a.ease) as Ease)
        : 'easeInOut'
      const W = p.canvas.width
      const H = p.canvas.height

      const targets: Target[] = []
      const focusRef = String(a.track ?? 'auto-cam')

      if (layout === 'pip') {
        const trackId = resolveTrack(focusRef, at)
        const clip = trackId ? activeVideoClipOn(trackId, at) : null
        if (!clip) return { ok: false, error: `no active video clip for track "${focusRef}" at ${at}s` }
        const scale = typeof a.scale === 'number' && a.scale > 0 ? a.scale : 0.25
        const margin = typeof a.margin === 'number' ? a.margin : 32
        const radius = typeof a.radius === 'number' ? a.radius : 0
        const corner = String(a.corner ?? 'bottom_right')
        const { w, h } = fitted(clip)
        const dx = W / 2 - (w * scale) / 2 - margin
        const dy = H / 2 - (h * scale) / 2 - margin
        const x = corner.includes('left') ? -dx : dx
        const y = corner.includes('top') ? -dy : dy
        targets.push({
          clip,
          props: {
            'transform.scale': scale,
            'transform.x': x,
            'transform.y': y,
            'transform.cornerRadius': radius,
            'transform.opacity': 1,
          },
        })
        // Every OTHER video track with an active clip goes fullscreen under it.
        for (const t of p.tracks.filter((t) => t.kind === 'video' && t.id !== (trackId ?? ''))) {
          const other = activeVideoClipOn(t.id, at)
          if (other && other.id !== clip.id)
            targets.push({
              clip: other,
              props: {
                'transform.scale': 1,
                'transform.x': 0,
                'transform.y': 0,
                'transform.cornerRadius': 0,
                'transform.opacity': 1,
              },
            })
        }
      } else if (layout === 'fullscreen') {
        const trackId = resolveTrack(focusRef, at)
        const clip = trackId ? activeVideoClipOn(trackId, at) : null
        if (!clip) return { ok: false, error: `no active video clip for track "${focusRef}" at ${at}s` }
        targets.push({
          clip,
          props: {
            'transform.scale': 1,
            'transform.x': 0,
            'transform.y': 0,
            'transform.cornerRadius': 0,
            'transform.opacity': 1,
          },
        })
      } else if (layout === 'hidden') {
        const trackId = resolveTrack(focusRef, at)
        const clip = trackId ? activeVideoClipOn(trackId, at) : null
        if (!clip) return { ok: false, error: `no active video clip for "${focusRef}"` }
        targets.push({ clip, props: { 'transform.opacity': 0 } })
      } else if (layout === 'side_by_side' || layout === 'top_bottom' || layout === 'grid') {
        const actives = p.tracks
          .filter((t) => t.kind === 'video')
          .map((t) => activeVideoClipOn(t.id, at))
          .filter((c): c is Clip => !!c)
        if (actives.length < 2)
          return { ok: false, error: `${layout} needs at least two active video tracks at ${at}s` }
        const slots =
          layout === 'side_by_side'
            ? [
                { x: -W / 4, y: 0 },
                { x: W / 4, y: 0 },
              ]
            : layout === 'top_bottom'
              ? [
                  { x: 0, y: -H / 4 },
                  { x: 0, y: H / 4 },
                ]
              : [
                  { x: -W / 4, y: -H / 4 },
                  { x: W / 4, y: -H / 4 },
                  { x: -W / 4, y: H / 4 },
                  { x: W / 4, y: H / 4 },
                ]
        actives.slice(0, slots.length).forEach((clip, i) => {
          targets.push({
            clip,
            props: {
              'transform.scale': 0.5,
              'transform.x': slots[i].x,
              'transform.y': slots[i].y,
              'transform.cornerRadius': 0,
              'transform.opacity': 1,
            },
          })
        })
      } else {
        return { ok: false, error: `unknown layout ${layout}` }
      }

      // Emit the coordinated pairs: current value at `at`, target at end.
      let kfCount = 0
      const s = st()
      const warnings: string[] = []
      for (const tgt of targets) {
        const relStart = at - tgt.clip.start
        const relEnd = relStart + duration
        if (relEnd < 0 || relStart > clipEnd(tgt.clip) - tgt.clip.start) {
          warnings.push(`${tgt.clip.id} is not active during the move window`)
          continue
        }
        for (const prop of LAYOUT_PROPS) {
          if (!(prop in tgt.props)) continue
          const current = resolveProp(tgt.clip, prop, Math.max(0, relStart))
          s.writeKeyframe(tgt.clip.id, prop, Math.max(0, relStart), current, ease)
          s.writeKeyframe(tgt.clip.id, prop, relEnd, tgt.props[prop], ease)
          kfCount += 2
        }
      }
      if (kfCount === 0) return { ok: false, error: 'no clips affected', warnings }
      return {
        ok: true,
        diff: `${layout} layout at ${at.toFixed(2)}s over ${duration.toFixed(2)}s — ${kfCount} keyframes on ${targets.length} clip${targets.length > 1 ? 's' : ''}`,
        warnings: warnings.length ? warnings : undefined,
      }
    },
  )
}
