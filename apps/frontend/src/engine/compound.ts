import type { Clip, Project, Track } from '../types/project'
import { clipEnd } from './time'

// Compound clips (pro-editor session, Phase 8). THE seam: render and audio
// consumers (flatten, playback, export specs) see an EFFECTIVE project with
// every compound clip replaced by its nested clips — time-shifted, trimmed
// to the compound's window, on synthetic tracks that preserve z stacking.
// Editing consumers keep the raw project; the compositor never learns about
// nesting.
//
// v1 limits, logged: the compound clip's own transform/effects/opacity do
// NOT apply to the group (that needs an offscreen group pass); nested speed
// is the clips' own (the compound clip's speed is ignored). Group/ungroup
// round-trips; open-to-edit-inside is deferred.

let memoKey: Project | null = null
let memoVal: Project | null = null

export function effectiveProject(p: Project): Project {
  const hasCompound = p.tracks.some((t) => t.clips.some((c) => c.compoundId))
  if (!hasCompound || !p.compounds) return p
  if (memoKey === p && memoVal) return memoVal

  const tracks: Track[] = []
  for (const tr of p.tracks) {
    const plain = tr.clips.filter((c) => !c.compoundId)
    tracks.push({ ...tr, clips: plain })
    for (const c of tr.clips) {
      if (!c.compoundId) continue
      const cmp = p.compounds[c.compoundId]
      if (!cmp) continue
      // Window into the nested timeline: [c.in, c.out], landing at c.start.
      const shift = c.start - c.in
      for (const [ni, nt] of cmp.tracks.entries()) {
        const clips: Clip[] = []
        for (const nc of nt.clips) {
          const ns = nc.start
          const ne = clipEnd(nc)
          const winStart = Math.max(ns, c.in)
          const winEnd = Math.min(ne, c.out)
          if (winEnd - winStart <= 1e-6) continue
          const copy = structuredClone(nc)
          // Trim to the visible window, preserving source mapping.
          copy.in = nc.in + (winStart - ns) * nc.speed
          copy.out = nc.in + (winEnd - ns) * nc.speed
          copy.start = winStart + shift
          copy.keyframes = copy.keyframes
            .map((k) => ({ ...k, t: k.t - (winStart - ns) }))
            .filter((k) => k.t >= -1e-6)
          clips.push(copy)
        }
        if (!clips.length) continue
        tracks.push({
          id: `${tr.id}:cmp:${c.id}:${ni}`,
          kind: nt.kind,
          // Nested stacking rides ABOVE the host track, below the next real
          // track: flatten scales z by 1000, nested adds its own order.
          z: tr.z * 1 + 0, // real z handled by flatten's scaling; keep host z
          name: `${nt.name} (${cmp.name})`,
          clips,
          muted: tr.muted,
          solo: tr.solo,
          hidden: tr.hidden,
          gain: tr.gain,
          // synthetic tracks carry nested order for flatten's z math:
          effects: nt.effects,
        })
        // annotate nested order out-of-band (flatten reads __nestedZ).
        ;(tracks[tracks.length - 1] as Track & { __nestedZ?: number }).__nestedZ = nt.z + 1
      }
    }
  }
  const out: Project = { ...p, tracks }
  memoKey = p
  memoVal = out
  return out
}
