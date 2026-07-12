import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { useStore } from '../state/store'
import type { Project } from '../types/project'

// Sync split per the spike brief: structure (tracks/clips/keyframes) goes over
// IPC only when it changes, debounced; the playhead is a cheap (t, playing)
// float pair sent on every change — Rust free-runs its own clock between samples.

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

interface SpikeMedia {
  path: string
  width: number
  height: number
  fps: number
  duration: number
}

// Only file-backed video clips reach the compositor; blob-URL media (browser
// file-input imports) stays DOM-only until native import fully replaces it.
function flatten(project: Project) {
  const layers = []
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue
    for (const clip of track.clips) {
      if (clip.kind !== 'video' || !clip.mediaId) continue
      const asset = project.media.find((m) => m.id === clip.mediaId)
      if (!asset || !asset.path.startsWith('/')) continue
      layers.push({
        id: clip.id,
        z: track.z,
        mediaPath: asset.path,
        start: clip.start,
        in: clip.in,
        out: clip.out,
        speed: clip.speed,
        transform: {
          x: clip.transform.x,
          y: clip.transform.y,
          scale: clip.transform.scale,
          rotation: clip.transform.rotation,
          opacity: clip.transform.opacity,
          cornerRadius: clip.transform.cornerRadius,
          crop: clip.transform.crop,
          shadow: clip.transform.shadow,
        },
        keyframes: clip.keyframes,
        transitions: clip.transitions,
        grade: clip.grade ?? null,
      })
    }
  }
  return {
    canvas: {
      width: project.canvas.width,
      height: project.canvas.height,
      fps: project.canvas.fps,
      background: project.canvas.background,
    },
    layers,
  }
}

let bridgeStarted = false

export function startCompositorBridge() {
  if (!isTauri) return
  // React StrictMode double-mounts effects; a second bridge would double every
  // IPC message and race any env-gated self-test against itself.
  if (bridgeStarted) return
  bridgeStarted = true

  let syncTimer: number | undefined
  let lastProject: Project | null = null
  let lastPlayhead = -1
  let lastPlaying = false
  let lastShuttle = 1

  const syncProject = (project: Project) => {
    window.clearTimeout(syncTimer)
    syncTimer = window.setTimeout(() => {
      void invoke('sync_project', { project: flatten(project) }).catch((e) =>
        console.error('sync_project failed:', e),
      )
    }, 60)
  }

  useStore.subscribe((s) => {
    if (s.project !== lastProject) {
      lastProject = s.project
      syncProject(s.project)
    }
    if (s.playhead !== lastPlayhead || s.playing !== lastPlaying || s.shuttle !== lastShuttle) {
      lastPlayhead = s.playhead
      lastPlaying = s.playing
      lastShuttle = s.shuttle
      void invoke('set_playhead', { t: s.playhead, playing: s.playing, rate: s.shuttle }).catch(
        () => {},
      )
    }
  })

  // Initial push.
  const s = useStore.getState()
  syncProject(s.project)
  void invoke('set_playhead', { t: s.playhead, playing: s.playing, rate: s.shuttle }).catch(
    () => {},
  )

  // Self-demo mode (SPIKE_DEMO=1): load and play the PiP demo with no clicks,
  // so the full webview→Rust loop is verifiable from logs alone.
  void invoke<boolean>('autorun_demo')
    .then((yes) => {
      if (yes) return loadPipDemo().then(() => useStore.getState().play())
    })
    .catch(() => {})

  // Persistence round-trip self-test (SPIKE_PERSIST_TEST=1): exercises the real
  // save→mutate→load path inside the actual webview, reporting into Rust logs.
  void invoke<boolean>('env_flag', { name: 'SPIKE_PERSIST_TEST' })
    .then((yes) => {
      if (yes) return runPersistenceSelfTest().then(() => runMissingMediaSelfTest())
    })
    .catch(() => {})

  // Clock-sync self-test (SPIKE_CLOCK_TEST=1): playhead vs Rust frame time
  // through play, scrub storm, and pause — the Part 2 unification claim.
  void invoke<boolean>('env_flag', { name: 'SPIKE_CLOCK_TEST' })
    .then((yes) => {
      if (yes) return runClockSyncSelfTest()
    })
    .catch(() => {})

  // Cross-process reopen test (SPIKE_REOPEN_TEST=1): loads the bundle a
  // PREVIOUS app process saved — quit-and-reopen persistence, plus recents.
  void invoke<boolean>('env_flag', { name: 'SPIKE_REOPEN_TEST' })
    .then((yes) => {
      if (yes) return runReopenSelfTest()
    })
    .catch(() => {})

  // Layout break-test (SPIKE_LAYOUT_TEST=1): drives the REAL native window
  // through below-minimum and extreme sizes, auditing the DOM at each.
  void invoke<boolean>('env_flag', { name: 'SPIKE_LAYOUT_TEST' })
    .then((yes) => {
      if (yes) return runLayoutSelfTest()
    })
    .catch(() => {})

  // Menu plumbing test (SPIKE_MENU_TEST=1): synthesizes events through the
  // real Rust menu handler and asserts the store reacted.
  void invoke<boolean>('env_flag', { name: 'SPIKE_MENU_TEST' })
    .then((yes) => {
      if (yes) return runMenuSelfTest()
    })
    .catch(() => {})
}

async function runMenuSelfTest() {
  const report = (pass: boolean, detail: string) =>
    invoke('report_test', { name: 'native-menu-plumbing', pass, detail }).catch(() => {})
  try {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const fire = (action: string) => invoke('emit_menu_action', { action })
    await wait(1500) // let listeners attach

    const snapBefore = useStore.getState().snap
    await fire('view:snap')
    await wait(300)
    const snapToggled = useStore.getState().snap === !snapBefore

    await loadPipDemo()
    await fire('edit:select_all')
    await wait(300)
    const allClips = useStore.getState().project.tracks.flatMap((t) => t.clips).length
    const selected = useStore.getState().selection.length
    const selectAllOk = allClips > 0 && selected === allClips

    await fire('file:new')
    await wait(300)
    const s = useStore.getState()
    const newOk =
      s.project.tracks.every((t) => t.clips.length === 0) &&
      s.projectPath === null &&
      s.past.length === 0

    const pass = snapToggled && selectAllOk && newOk
    void report(
      pass,
      `snapToggled=${snapToggled} selectAll=${selected}/${allClips} newProject=${newOk}`,
    )
  } catch (e) {
    void report(false, String(e))
  }
}

async function runLayoutSelfTest() {
  const report = (pass: boolean, detail: string) =>
    invoke('report_test', { name: 'layout-native-window', pass, detail }).catch(() => {})
  try {
    const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window')
    const win = getCurrentWindow()
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    await loadPipDemo()
    useStore.getState().setTimelineHeight(480)
    useStore.getState().setPropsWidth(420)

    const audit = (label: string) => {
      const s = useStore.getState()
      const stage = document.querySelector('.preview__stage')?.getBoundingClientRect()
      const ar = stage && stage.height > 0 ? stage.width / stage.height : 0
      const want = s.project.canvas.width / s.project.canvas.height
      const lanes = [
        ...new Set(
          [...document.querySelectorAll('.tl__lane')].map((l) =>
            Math.round(l.getBoundingClientRect().height),
          ),
        ),
      ]
      const checks = {
        hasStage: !!stage,
        ar: Math.abs(ar - want) < 0.02,
        wide: !!stage && stage.width >= 100,
        noHOv: !(document.body.scrollWidth > window.innerWidth),
        lanes: lanes.every((h) => h === 56 || h === 44),
      }
      const ok = Object.values(checks).every(Boolean)
      const failed = Object.entries(checks)
        .filter(([, v]) => !v)
        .map(([k]) => k)
        .join(',')
      return {
        ok,
        detail: `${label}: vp=${window.innerWidth}x${window.innerHeight} stage=${Math.round(stage?.width ?? 0)}x${Math.round(stage?.height ?? 0)} arErr=${Math.abs(ar - want).toFixed(3)} lanes=${lanes.join('/')}${failed ? ` FAILED[${failed}]` : ''}`,
      }
    }

    const results = []
    // 1) Force BELOW the minimum. macOS applies minSize to user drags, not to
    // programmatic setSize — so the pass criterion here is that the LAYOUT
    // stays coherent even in this unreachable-by-user state; whether the OS
    // clamped is reported as info.
    await win.setSize(new LogicalSize(500, 400))
    await wait(600)
    results.push({
      ok: true,
      detail: `below-min info: requested 500x400, got ${window.innerWidth}x${window.innerHeight}`,
    })
    results.push(audit('below-min-coherence'))
    // 2) Extreme wide/short
    await win.setSize(new LogicalSize(2200, 620))
    await wait(600)
    results.push(audit('wide-short'))
    // 3) Extreme narrow/tall
    await win.setSize(new LogicalSize(960, 1400))
    await wait(600)
    results.push(audit('narrow-tall'))
    // Restore something sane.
    await win.setSize(new LogicalSize(1280, 800))

    const pass = results.every((r) => r.ok)
    void report(pass, results.map((r) => r.detail).join(' | '))
  } catch (e) {
    void report(false, String(e))
  }
}

async function runReopenSelfTest() {
  const report = (pass: boolean, detail: string) =>
    invoke('report_test', { name: 'reopen-across-processes', pass, detail }).catch(() => {})
  try {
    const { openProjectPath, listRecents } = await import('../persistence/projectIO')
    const recents = await listRecents()
    const entry = recents.find((r) => r.name === 'persist-e2e')
    if (!entry) {
      void report(false, `bundle not in recents (got: ${recents.map((r) => r.name).join(', ')})`)
      return
    }
    await openProjectPath(entry.path)
    const p = useStore.getState().project
    const clips = p.tracks.flatMap((t) => t.clips)
    const kfs = clips.reduce((n, c) => n + c.keyframes.length, 0)
    const texts = clips.filter((c) => c.kind === 'text').length
    const transitions = clips.filter((c) => c.transitions.in || c.transitions.out).length
    // The demo project: 2 video clips + 1 text; 16 PiP keyframes + text preset
    // keyframes; 1 dissolve. All must survive the process boundary.
    const pass = clips.length === 3 && kfs >= 16 && texts === 1 && transitions === 1
    void report(
      pass,
      `clips=${clips.length} keyframes=${kfs} texts=${texts} transitions=${transitions} (via recents db)`,
    )
  } catch (e) {
    void report(false, String(e))
  }
}

async function runMissingMediaSelfTest() {
  const report = (pass: boolean, detail: string) =>
    invoke('report_test', { name: 'persist-missing-media', pass, detail }).catch(() => {})
  try {
    const { serializeProject, openProjectPath } = await import('../persistence/projectIO')
    const s = useStore.getState()
    const project = JSON.parse(serializeProject(s.project))
    if (!project.media?.[1]) {
      void report(false, 'needs the demo project loaded first')
      return
    }
    project.media[1].path = '/nonexistent/deleted-source.mp4'
    const bundle = (s.project.media[0]?.path ?? '').replace(
      /screen\.mp4$/,
      'missing-e2e.motionaire',
    )
    await invoke('save_project', {
      bundlePath: bundle,
      projectJson: JSON.stringify(project),
      name: 'missing-e2e',
    })
    await openProjectPath(bundle)
    const after = useStore.getState().project
    const flagged = after.media[1]?.missing === true
    const othersOk = after.media[0]?.missing !== true && !!after.media[0]?.playbackUrl
    const clipsIntact = after.tracks.flatMap((t) => t.clips).length > 0
    void report(
      flagged && othersOk && clipsIntact,
      `flagged=${flagged} othersOk=${othersOk} clipsIntact=${clipsIntact}`,
    )
  } catch (e) {
    void report(false, String(e))
  }
}

async function runClockSyncSelfTest() {
  const report = (pass: boolean, detail: string) =>
    invoke('report_test', { name: 'clock-sync', pass, detail }).catch(() => {})
  try {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const frameT = () =>
      (window as unknown as { __motionaire?: { lastFrameT?: number } }).__motionaire?.lastFrameT ??
      NaN
    await wait(3000) // let demo autorun + compositor settle

    // Phase 1: steady playback — sampled drift between store and Rust frames.
    useStore.getState().setPlayhead(0.5)
    useStore.getState().play()
    const drifts: number[] = []
    for (let i = 0; i < 10; i++) {
      await wait(300)
      drifts.push(Math.abs(useStore.getState().playhead - frameT()))
    }
    const maxPlayDrift = Math.max(...drifts)

    // Phase 2: scrub storm while paused — final frame must land on the target.
    useStore.getState().pause()
    for (let i = 0; i < 30; i++) {
      useStore.getState().setPlayhead(Math.random() * 8)
      await wait(20)
    }
    useStore.getState().setPlayhead(4.0)
    await wait(600)
    const scrubSettle = Math.abs(4.0 - frameT())

    // Phase 3: pause mid-transition region and seek during a text animation.
    useStore.getState().setPlayhead(1.6)
    await wait(400)
    const pauseSettle = Math.abs(1.6 - frameT())

    // Frame quantization + one sample of latency: playing tolerance 150ms;
    // paused the compositor must land within one frame (33ms) + header f32 eps.
    const pass = maxPlayDrift < 0.15 && scrubSettle < 0.05 && pauseSettle < 0.05
    void report(
      pass,
      `playDrift=${maxPlayDrift.toFixed(3)}s scrubSettle=${scrubSettle.toFixed(3)}s pauseSettle=${pauseSettle.toFixed(3)}s`,
    )
  } catch (e) {
    void report(false, String(e))
  }
}

async function runPersistenceSelfTest() {
  const report = (pass: boolean, detail: string) =>
    invoke('report_test', { name: 'persist-roundtrip', pass, detail }).catch(() => {})
  try {
    const { serializeProject, openProjectPath } = await import('../persistence/projectIO')
    await loadPipDemo()
    const st = useStore.getState()
    // Enrich the project so the round-trip covers more of the model.
    st.addTextClip('Persistence test title')
    const v1clips = useStore
      .getState()
      .project.tracks.filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips)
      .filter((c) => c.kind === 'video')
    if (v1clips[1])
      useStore.getState().setTransition(v1clips[1].id, 'in', { type: 'dissolve', duration: 0.7 })

    const before = serializeProject(useStore.getState().project)
    const screenPath = useStore.getState().project.media[0]?.path ?? ''
    const bundle = screenPath.replace(/screen\.mp4$/, 'persist-e2e.motionaire')
    if (!bundle.endsWith('.motionaire')) {
      void report(false, 'could not derive bundle path')
      return
    }
    await invoke('save_project', { bundlePath: bundle, projectJson: before, name: 'persist-e2e' })

    // Wreck the in-memory state, then load the bundle back.
    useStore.getState().deleteClips(v1clips.map((c) => c.id))
    useStore.getState().setPlayhead(2.0)
    await openProjectPath(bundle)

    const after = serializeProject(useStore.getState().project)
    const restoredMedia = useStore.getState().project.media
    const urlsRebuilt = restoredMedia.every((m) => !m.path.startsWith('/') || !!m.playbackUrl)
    const noneMissing = restoredMedia.every((m) => !m.missing)
    if (after === before && urlsRebuilt && noneMissing && useStore.getState().playhead === 0) {
      void report(true, `bytes identical (${before.length}), playbackUrls rebuilt, playhead reset`)
    } else {
      void report(
        false,
        `identical=${after === before} urls=${urlsRebuilt} missing=${!noneMissing} len ${before.length}→${after.length}`,
      )
    }
  } catch (e) {
    void report(false, String(e))
  }
}

export async function loadPipDemo() {
  const [screen, cam] = await invoke<[SpikeMedia, SpikeMedia]>('spike_setup')
  useStore
    .getState()
    .loadPipDemo(
      { ...screen, playbackUrl: convertFileSrc(screen.path) },
      { ...cam, playbackUrl: convertFileSrc(cam.path) },
    )
}
