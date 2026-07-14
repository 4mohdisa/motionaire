import { defaultTransform, uid } from '../types/project'
import type { Clip } from '../types/project'

// Shared unit-test fixture builder. Lives outside *.test.ts so importing it
// doesn't re-register another file's tests (vitest collects by filename).
export function mkClip(patch: Partial<Clip> = {}): Clip {
  return {
    id: uid('c'),
    kind: 'video',
    mediaId: 'm1',
    start: 0,
    in: 0,
    out: 4,
    speed: 1,
    volume: 1,
    transform: defaultTransform(),
    keyframes: [],
    transitions: { in: null, out: null },
    effects: [],
    ...patch,
  }
}
