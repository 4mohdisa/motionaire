import { useStore } from '../state/store'
import { clipDuration, clipEnd, findClip, snapToFrame } from '../engine/time'
import { EFFECT_DEFAULTS, EFFECT_LABELS } from '../engine/effectStack'
import type { Clip, EffectType, Project, TransitionType } from '../types/project'

// ============================================================================
// THE TOOL LAYER (Run 1, Phase 3 — context.md §2).
//
// THE GOVERNING PRINCIPLE: the AI edits the TIMELINE, not the PIXELS. Every
// tool here mutates the project document through the SAME store actions the
// UI uses — locks, validation, frame-snapping, dirty-tracking, and undo all
// come from the store, not from this file. There is no second mutation path.
//
// Times in the tool API are SECONDS, timeline-absolute (what a human or an
// LLM naturally says). Keyframe storage is clip-relative; the conversion
// happens here (CONTEXT.md §1.2 demands both sides exist).
// ============================================================================

export interface ToolResult {
  ok: boolean
  diff?: string
  warnings?: string[]
  data?: unknown
  error?: string
}

export interface ToolSpec {
  name: string
  description: string
  schema: Record<string, unknown> // JSON Schema for the input object
}

const st = () => useStore.getState()
const proj = () => st().project

function clip(id: string): { c: Clip; trackId: string; locked: boolean } | null {
  const found = findClip(proj(), id)
  if (!found) return null
  return { c: found.clip, trackId: found.track.id, locked: !!found.track.locked }
}

function fail(error: string): ToolResult {
  return { ok: false, error }
}

function clipName(c: Clip): string {
  if (c.text) return `text "${c.text.content.slice(0, 24)}"`
  const asset = proj().media.find((m) => m.id === c.mediaId)
  return asset?.name ?? c.kind
}

const fmtT = (t: number) => `${t.toFixed(2)}s`

// Guard shared by every mutating tool.
function editable(id: string): { c: Clip; trackId: string } | ToolResult {
  const found = clip(id)
  if (!found) return fail(`No clip with id ${id} — call get_timeline for current ids`)
  if (found.locked) return fail(`Track holding ${clipName(found.c)} is locked`)
  return { c: found.c, trackId: found.trackId }
}

const KEYFRAMEABLE = [
  'transform.x',
  'transform.y',
  'transform.scale',
  'transform.rotation',
  'transform.opacity',
  'transform.cornerRadius',
  'volume',
  'speed',
]

// ---------------------------------------------------------------------------
// Compact timeline context (context.md §2.1): what the model sees. Never the
// raw JSON — projects grow; this stays skimmable.
// ---------------------------------------------------------------------------
export function buildTimelineContext(): string {
  const p = proj()
  const s = st()
  const lines: string[] = []
  lines.push(
    `canvas ${p.canvas.width}x${p.canvas.height} @${p.canvas.fps}fps · duration ${fmtT(p.duration)} · playhead ${fmtT(s.playhead)}`,
  )
  if (s.selection.length) lines.push(`selection: ${s.selection.join(', ')}`)
  for (const t of p.tracks) {
    const flags = [t.locked && 'locked', t.muted && 'muted', t.hidden && 'hidden']
      .filter(Boolean)
      .join(',')
    lines.push(`track ${t.id} "${t.name}" (${t.kind}${flags ? ', ' + flags : ''}):`)
    for (const c of [...t.clips].sort((a, b) => a.start - b.start)) {
      const fx = c.effects.length
        ? ` fx=[${c.effects.map((e) => `${e.type}#${e.id}`).join(',')}]`
        : ''
      const kf = c.keyframes.length ? ` kf=${c.keyframes.length}` : ''
      lines.push(
        `  clip ${c.id} "${clipName(c)}" ${fmtT(c.start)}–${fmtT(clipEnd(c))} (src ${fmtT(c.in)}–${fmtT(c.out)}, speed ${c.speed})${fx}${kf}`,
      )
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Tool registry: spec + executor together so they cannot drift.
// ---------------------------------------------------------------------------
type Executor = (args: Record<string, unknown>) => ToolResult

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

export const TOOLS: { spec: ToolSpec; run: Executor }[] = [
  {
    spec: {
      name: 'get_timeline',
      description:
        'Refresh the current timeline state: tracks, clips with ids and times, effects, selection. Call when ids or times may be stale.',
      schema: { type: 'object', properties: {}, required: [] },
    },
    run: () => ({ ok: true, data: buildTimelineContext() }),
  },
  {
    spec: {
      name: 'split_clip',
      description: 'Split a clip at a timeline time (seconds). Both halves keep effects/keyframes.',
      schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          at: { type: 'number', description: 'timeline seconds' },
        },
        required: ['clip_id', 'at'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      const at = num(a.at)
      if (at === null) return fail('at must be a number (seconds)')
      if (at <= e.c.start || at >= clipEnd(e.c))
        return fail(
          `at=${fmtT(at)} is outside ${clipName(e.c)} (${fmtT(e.c.start)}–${fmtT(clipEnd(e.c))})`,
        )
      const before = proj().tracks.flatMap((t) => t.clips).length
      st().splitClip(String(a.clip_id), at)
      const after = proj().tracks.flatMap((t) => t.clips).length
      return after > before
        ? { ok: true, diff: `Split ${clipName(e.c)} at ${fmtT(at)}` }
        : fail('Split refused (too close to a clip edge)')
    },
  },
  {
    spec: {
      name: 'trim_clip',
      description:
        'Move a clip edge to a timeline time. edge "in" = left edge, "out" = right edge.',
      schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          edge: { type: 'string', enum: ['in', 'out'] },
          to: { type: 'number', description: 'timeline seconds' },
        },
        required: ['clip_id', 'edge', 'to'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      const to = num(a.to)
      if (to === null || (a.edge !== 'in' && a.edge !== 'out')) return fail('bad edge/to')
      st().trimClip(String(a.clip_id), a.edge, to)
      const now = clip(String(a.clip_id))!.c
      return {
        ok: true,
        diff: `Trimmed ${clipName(now)} to ${fmtT(now.start)}–${fmtT(clipEnd(now))}`,
      }
    },
  },
  {
    spec: {
      name: 'move_clip',
      description:
        'Move a clip to a new start time, optionally to another track. Rejects collisions.',
      schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          start: { type: 'number' },
          track_id: { type: 'string' },
        },
        required: ['clip_id', 'start'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      const start = num(a.start)
      if (start === null) return fail('start must be a number')
      st().moveClipsTo([{ id: String(a.clip_id), start, trackId: str(a.track_id) ?? undefined }])
      const now = clip(String(a.clip_id))!
      const moved = Math.abs(now.c.start - start) < 1 / proj().canvas.fps
      return moved
        ? { ok: true, diff: `Moved ${clipName(now.c)} to ${fmtT(now.c.start)}` }
        : fail('Move rejected (collision, locked track, or wrong track kind)')
    },
  },
  {
    spec: {
      name: 'delete_clips',
      description: 'Delete clips by id. ripple=true closes the gaps left behind.',
      schema: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' } },
          ripple: { type: 'boolean' },
        },
        required: ['clip_ids'],
      },
    },
    run: (a) => {
      const ids = Array.isArray(a.clip_ids) ? a.clip_ids.map(String) : []
      if (!ids.length) return fail('clip_ids is empty')
      const names = ids
        .map((i) => clip(i))
        .filter(Boolean)
        .map((f) => clipName(f!.c))
      if (!names.length) return fail('no matching clips')
      if (a.ripple) st().rippleDeleteClips(ids)
      else st().deleteClips(ids)
      return { ok: true, diff: `Deleted ${names.join(', ')}${a.ripple ? ' (rippled)' : ''}` }
    },
  },
  {
    spec: {
      name: 'delete_range',
      description:
        'Remove everything between two timeline times (track_id, or "all" for every track), splitting clips at the boundaries. ripple=true closes the gap.',
      schema: {
        type: 'object',
        properties: {
          track_id: { type: 'string' },
          start: { type: 'number' },
          end: { type: 'number' },
          ripple: { type: 'boolean' },
        },
        required: ['track_id', 'start', 'end'],
      },
    },
    run: (a) => {
      const s0 = num(a.start)
      const e0 = num(a.end)
      if (s0 === null || e0 === null || e0 <= s0) return fail('bad range')
      // track_id "all" (or omitted) sweeps every unlocked track.
      if (!a.track_id || a.track_id === 'all') {
        const diffs: string[] = []
        for (const t of proj().tracks.filter((tr) => !tr.locked)) {
          const r = runTool('delete_range', { ...a, track_id: t.id })
          if (r.ok && r.diff) diffs.push(r.diff)
        }
        return diffs.length
          ? { ok: true, diff: diffs.join('; ') }
          : fail('nothing in that range on any track')
      }
      const track = proj().tracks.find((t) => t.id === String(a.track_id))
      if (!track) return fail(`no track ${a.track_id}`)
      if (track.locked) return fail('track is locked')
      // Split boundaries first (splitClip no-ops near edges, which is fine),
      // then collect wholly-inside clips and delete.
      for (const c of [...track.clips]) {
        if (c.start < s0 && clipEnd(c) > s0) st().splitClip(c.id, s0)
      }
      for (const c of [...proj().tracks.find((t) => t.id === track.id)!.clips]) {
        if (c.start < e0 && clipEnd(c) > e0) st().splitClip(c.id, e0)
      }
      const doomed = proj()
        .tracks.find((t) => t.id === track.id)!
        .clips.filter((c) => c.start >= s0 - 1e-6 && clipEnd(c) <= e0 + 1e-6)
        .map((c) => c.id)
      if (!doomed.length) return fail('nothing in that range')
      if (a.ripple) st().rippleDeleteClips(doomed)
      else st().deleteClips(doomed)
      return {
        ok: true,
        diff: `Removed ${fmtT(s0)}–${fmtT(e0)} on ${track.name} (${doomed.length} piece${doomed.length > 1 ? 's' : ''})${a.ripple ? ', gap closed' : ''}`,
      }
    },
  },
  {
    spec: {
      name: 'duplicate_clip',
      description: 'Duplicate a clip; the copy lands right after the original.',
      schema: {
        type: 'object',
        properties: { clip_id: { type: 'string' } },
        required: ['clip_id'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      const before = proj().tracks.flatMap((t) => t.clips).length
      st().duplicateClip(String(a.clip_id))
      return proj().tracks.flatMap((t) => t.clips).length > before
        ? { ok: true, diff: `Duplicated ${clipName(e.c)}` }
        : fail('No room to place the duplicate')
    },
  },
  {
    spec: {
      name: 'set_property',
      description: `Set a clip property. Numeric properties: ${KEYFRAMEABLE.join(', ')}, pan (-1..1). If the property has keyframes, this writes a keyframe at the playhead instead.`,
      schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          property: { type: 'string' },
          value: { type: 'number' },
        },
        required: ['clip_id', 'property', 'value'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      const prop = String(a.property)
      const v = num(a.value)
      if (v === null) return fail('value must be a number')
      if (!KEYFRAMEABLE.includes(prop) && prop !== 'pan' && !prop.startsWith('fx.'))
        return fail(`unknown property ${prop}`)
      st().setClipProperty(String(a.clip_id), prop, v)
      return { ok: true, diff: `${clipName(e.c)}: ${prop} → ${v}` }
    },
  },
  {
    spec: {
      name: 'add_keyframe',
      description:
        'Add a keyframe: property reaches value at timeline time `at`. Ease: linear|easeIn|easeOut|easeInOut|spring.',
      schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          property: { type: 'string' },
          at: { type: 'number', description: 'timeline seconds (absolute)' },
          value: { type: 'number' },
          ease: { type: 'string' },
        },
        required: ['clip_id', 'property', 'at', 'value'],
      },
    },
    run: (a) => addKeyframeAbs(a),
  },
  {
    spec: {
      name: 'animate',
      description:
        'Animate a property from one value to another over a window: emits the two keyframes. THE go-to tool for "…then back" motions (call twice).',
      schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          property: { type: 'string' },
          from: { type: 'number' },
          to: { type: 'number' },
          start: { type: 'number', description: 'timeline seconds' },
          duration: { type: 'number', description: 'seconds' },
          ease: { type: 'string' },
        },
        required: ['clip_id', 'property', 'from', 'to', 'start', 'duration'],
      },
    },
    run: (a) => {
      const start = num(a.start)
      const durn = num(a.duration)
      if (start === null || durn === null || durn <= 0) return fail('bad start/duration')
      const r1 = addKeyframeAbs({ ...a, at: start, value: a.from })
      if (!r1.ok) return r1
      const r2 = addKeyframeAbs({ ...a, at: start + durn, value: a.to })
      if (!r2.ok) return r2
      const e = clip(String(a.clip_id))!
      return {
        ok: true,
        diff: `Animated ${clipName(e.c)} ${a.property}: ${a.from} → ${a.to} over ${fmtT(start)}–${fmtT(start + durn)}`,
        warnings: [...(r1.warnings ?? []), ...(r2.warnings ?? [])],
      }
    },
  },
  {
    spec: {
      name: 'clear_keyframes',
      description: 'Remove all keyframes for a property on a clip.',
      schema: {
        type: 'object',
        properties: { clip_id: { type: 'string' }, property: { type: 'string' } },
        required: ['clip_id', 'property'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      st().clearKeyframes(String(a.clip_id), String(a.property))
      return { ok: true, diff: `Cleared ${a.property} keyframes on ${clipName(e.c)}` }
    },
  },
  {
    spec: {
      name: 'add_effect',
      description: `Add an effect to a clip's stack. Types: ${Object.keys(EFFECT_LABELS).join(', ')}. Returns the effect id for set_effect_param.`,
      schema: {
        type: 'object',
        properties: { clip_id: { type: 'string' }, type: { type: 'string' } },
        required: ['clip_id', 'type'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      const type = String(a.type) as EffectType
      if (!(type in EFFECT_DEFAULTS)) return fail(`unknown effect type ${a.type}`)
      st().addEffect(String(a.clip_id), type)
      const fx = clip(String(a.clip_id))!.c.effects.at(-1)!
      return {
        ok: true,
        diff: `Added ${EFFECT_LABELS[type]} to ${clipName(e.c)}`,
        data: { effect_id: fx.id, params: fx.params },
      }
    },
  },
  {
    spec: {
      name: 'set_effect_param',
      description:
        'Set one parameter on an effect instance (see add_effect data.params for names).',
      schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          effect_id: { type: 'string' },
          param: { type: 'string' },
          value: {},
        },
        required: ['clip_id', 'effect_id', 'param', 'value'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      const fx = e.c.effects.find((f) => f.id === String(a.effect_id))
      if (!fx) return fail(`no effect ${a.effect_id} on that clip`)
      st().updateEffectParams(String(a.clip_id), String(a.effect_id), {
        [String(a.param)]: a.value as number | string | boolean,
      })
      return { ok: true, diff: `${EFFECT_LABELS[fx.type]}: ${a.param} → ${a.value}` }
    },
  },
  {
    spec: {
      name: 'remove_effect',
      description: 'Remove an effect instance from a clip.',
      schema: {
        type: 'object',
        properties: { clip_id: { type: 'string' }, effect_id: { type: 'string' } },
        required: ['clip_id', 'effect_id'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      const fx = e.c.effects.find((f) => f.id === String(a.effect_id))
      if (!fx) return fail(`no effect ${a.effect_id}`)
      st().removeEffect(String(a.clip_id), String(a.effect_id))
      return { ok: true, diff: `Removed ${EFFECT_LABELS[fx.type]} from ${clipName(e.c)}` }
    },
  },
  {
    spec: {
      name: 'add_text',
      description:
        'Add a text clip. Returns its clip id. Optional style: size, color (#hex), align, font.',
      schema: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          start: { type: 'number' },
          duration: { type: 'number' },
          size: { type: 'number' },
          color: { type: 'string' },
        },
        required: ['content', 'start', 'duration'],
      },
    },
    run: (a) => {
      const content = str(a.content)
      const start = num(a.start)
      const durn = num(a.duration)
      if (!content || start === null || durn === null || durn <= 0)
        return fail('need content, start, duration')
      st().setPlayhead(start)
      const before = new Set(proj().tracks.flatMap((t) => t.clips.map((c) => c.id)))
      st().addTextClip(content)
      const added = proj()
        .tracks.flatMap((t) => t.clips)
        .find((c) => !before.has(c.id))
      if (!added) return fail('no room at that time on the top track')
      // Placement may clamp; honest diff uses the actual position.
      st().trimClip(added.id, 'out', added.start + durn)
      const patch: Record<string, unknown> = {}
      if (num(a.size) !== null) patch.size = a.size
      if (str(a.color)) patch.color = a.color
      if (Object.keys(patch).length) st().updateTextClip(added.id, { style: patch })
      const now = clip(added.id)!.c
      return {
        ok: true,
        diff: `Added text "${content}" at ${fmtT(now.start)} for ${fmtT(clipDuration(now))}`,
        data: { clip_id: added.id },
        warnings:
          Math.abs(now.start - start) > 0.5
            ? [`placed at ${fmtT(now.start)} (requested ${fmtT(start)} was occupied)`]
            : undefined,
      }
    },
  },
  {
    spec: {
      name: 'edit_text',
      description: 'Change a text clip: content and/or style (size, color, align, font).',
      schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          content: { type: 'string' },
          size: { type: 'number' },
          color: { type: 'string' },
        },
        required: ['clip_id'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      if (!e.c.text) return fail('not a text clip')
      const style: Record<string, unknown> = {}
      if (num(a.size) !== null) style.size = a.size
      if (str(a.color)) style.color = a.color
      st().updateTextClip(String(a.clip_id), {
        content: str(a.content) ?? undefined,
        style: Object.keys(style).length ? style : undefined,
      })
      return { ok: true, diff: `Updated text clip` }
    },
  },
  {
    spec: {
      name: 'set_canvas',
      description: 'Set the canvas preset: youtube_16x9 | tiktok_9x16 | square_1x1 | portrait_4x5.',
      schema: {
        type: 'object',
        properties: { preset: { type: 'string' } },
        required: ['preset'],
      },
    },
    run: (a) => {
      const map: Record<string, { width: number; height: number }> = {
        youtube_16x9: { width: 1920, height: 1080 },
        tiktok_9x16: { width: 1080, height: 1920 },
        square_1x1: { width: 1080, height: 1080 },
        portrait_4x5: { width: 1080, height: 1350 },
      }
      const p = map[String(a.preset)]
      if (!p) return fail(`unknown preset ${a.preset}`)
      st().setCanvasPreset(p)
      return { ok: true, diff: `Canvas → ${a.preset} (${p.width}×${p.height})` }
    },
  },
  {
    spec: {
      name: 'add_transition',
      description:
        'Add a transition on a clip edge. Types include dissolve, fade, slide, push, wipe, zoom, spin, iris.',
      schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          edge: { type: 'string', enum: ['in', 'out'] },
          type: { type: 'string' },
          duration: { type: 'number' },
        },
        required: ['clip_id', 'edge', 'type', 'duration'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      const d = num(a.duration)
      if (d === null || d <= 0 || (a.edge !== 'in' && a.edge !== 'out'))
        return fail('bad edge/duration')
      st().setTransition(String(a.clip_id), a.edge, {
        type: String(a.type) as TransitionType,
        duration: Math.min(d, clipDuration(e.c) / 2),
      })
      return { ok: true, diff: `${a.type} ${a.edge}-transition on ${clipName(e.c)} (${fmtT(d)})` }
    },
  },
  {
    spec: {
      name: 'add_fade',
      description: 'Audio fade at a clip edge.',
      schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          edge: { type: 'string', enum: ['in', 'out'] },
          duration: { type: 'number' },
        },
        required: ['clip_id', 'edge'],
      },
    },
    run: (a) => {
      const e = editable(String(a.clip_id))
      if ('ok' in e) return e
      if (a.edge !== 'in' && a.edge !== 'out') return fail('bad edge')
      st().addFade(String(a.clip_id), a.edge, num(a.duration) ?? 0.5)
      return { ok: true, diff: `Fade ${a.edge} on ${clipName(e.c)}` }
    },
  },
]

// add_keyframe with ABSOLUTE time (converted to clip-relative here).
function addKeyframeAbs(a: Record<string, unknown>): ToolResult {
  const e = editable(String(a.clip_id))
  if ('ok' in e) return e
  const at = num(a.at)
  const v = num(a.value)
  const prop = String(a.property)
  if (at === null || v === null) return fail('need at + value numbers')
  if (!KEYFRAMEABLE.includes(prop) && !prop.startsWith('fx.'))
    return fail(`property ${prop} is not keyframeable`)
  const fps = proj().canvas.fps
  const warnings: string[] = []
  let rel = at - e.c.start
  const durn = clipDuration(e.c)
  if (rel < 0 || rel > durn) {
    warnings.push(`at=${fmtT(at)} clamped into ${clipName(e.c)}'s window`)
    rel = Math.min(Math.max(0, rel), durn)
  }
  rel = snapToFrame(rel, fps)
  const ease = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'spring'].includes(String(a.ease))
    ? (String(a.ease) as Clip['keyframes'][number]['ease'])
    : 'easeInOut'
  // Same path the panel's stopwatch uses: playhead-anchored toggle would
  // fight multi-keyframe scripts, so write through setPlayhead+setProperty:
  st().setPlayhead(e.c.start + rel)
  // Arm the property (first keyframe) then write the value at the playhead.
  const already = e.c.keyframes.some((k) => k.prop === prop)
  if (!already) st().toggleKeyframe(String(a.clip_id), prop)
  st().setClipProperty(String(a.clip_id), prop, v)
  // Ensure ease on the keyframe just written.
  st().setKeyframeEase(String(a.clip_id), prop, rel, ease)
  return {
    ok: true,
    diff: `Keyframe ${prop}=${v} at ${fmtT(e.c.start + rel)} on ${clipName(e.c)}`,
    warnings: warnings.length ? warnings : undefined,
  }
}

export function toolSpecs(): ToolSpec[] {
  return TOOLS.map((t) => t.spec)
}

export function runTool(name: string, args: Record<string, unknown>): ToolResult {
  const tool = TOOLS.find((t) => t.spec.name === name)
  if (!tool) return fail(`unknown tool ${name}`)
  try {
    return tool.run(args ?? {})
  } catch (e) {
    return fail(`tool ${name} threw: ${e}`)
  }
}

// Phase 5 registers set_layout here (layout macros).
export function registerTool(spec: ToolSpec, run: Executor): void {
  const i = TOOLS.findIndex((t) => t.spec.name === spec.name)
  if (i >= 0) TOOLS.splice(i, 1)
  TOOLS.push({ spec, run })
}

export type { Project }
