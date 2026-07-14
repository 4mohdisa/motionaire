import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../state/store'
import { createProject } from '../types/project'
import { isTauri, loadPipDemo } from '../compositor/bridge'
import {
  importMediaNative,
  openProject,
  openProjectPath,
  saveProject,
} from '../persistence/projectIO'

// Native-menu → app dispatch. Accelerators on native items are global, so
// text-editing keys (Cmd+Z / Cmd+A) route back to the focused field when the
// user is typing — matching what a Mac user expects.

let started = false

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el?.isContentEditable ?? false)
  )
}

// Stack-era helper for dev tests: first effect of a type (adding if absent),
// returning the fx.<id>. prefix its params/keyframes live under.
function ensureFx(
  clipId: string,
  type: import('../types/project').EffectType,
): string {
  // Re-read state per lookup: zustand snapshots are immutable, so a state
  // captured before addEffect can never see the new instance.
  const find = () =>
    useStore
      .getState()
      .project.tracks.flatMap((t) => t.clips)
      .find((c) => c.id === clipId)!
      .effects.find((e) => e.type === type)
  let fx = find()
  if (!fx) {
    useStore.getState().addEffect(clipId, type)
    fx = find()
  }
  return `fx.${fx!.id}.`
}

async function dispatch(action: string, path?: string) {
  const s = useStore.getState()
  switch (action) {
    case 'file:new': {
      const { guardDirty } = await import('../hooks/unsaved')
      if (!(await guardDirty())) break
      // Passing the guard on an untitled project abandons it deliberately —
      // drop its crash copy so the launcher stops offering it.
      if (!s.projectPath) void invoke('clear_untitled_recovery').catch(() => {})
      s.replaceProject(createProject(), null)
      break
    }
    case 'file:open': {
      const { guardDirty } = await import('../hooks/unsaved')
      if (!(await guardDirty())) break
      await openProject()
      break
    }
    case 'file:open_recent': {
      const { guardDirty } = await import('../hooks/unsaved')
      if (!(await guardDirty())) break
      if (path) await openProjectPath(path)
      break
    }
    case 'file:save':
      await saveProject()
      break
    case 'file:save_as':
      await saveProject(true)
      break
    case 'file:close': {
      const { guardDirty } = await import('../hooks/unsaved')
      if (!(await guardDirty())) break
      if (!s.projectPath) void invoke('clear_untitled_recovery').catch(() => {})
      // Back to the launcher; the editor is a full-window view it replaces.
      s.pause()
      s.replaceProject(createProject(), null)
      s.setAppView('launcher')
      break
    }
    case 'file:import':
      await importMediaNative()
      break
    case 'app:settings':
      s.setDialog('preferences')
      break
    case 'file:project_settings':
      s.setDialog('projectSettings')
      break
    case 'file:consolidate': {
      const { consolidateMedia } = await import('../persistence/projectIO')
      try {
        await consolidateMedia()
      } catch (e) {
        useStore.getState().pushToast('error', `Consolidate failed: ${e}`)
      }
      break
    }
    case 'file:import_font': {
      const { importFontFlow } = await import('../persistence/fontManager')
      await importFontFlow()
      break
    }
    case 'edit:undo':
      if (isTyping()) document.execCommand('undo')
      else s.undo()
      break
    case 'edit:redo':
      if (isTyping()) document.execCommand('redo')
      else s.redo()
      break
    case 'edit:delete':
      if (!isTyping() && s.selection.length) s.deleteClips(s.selection)
      break
    case 'edit:ripple_delete':
      if (!isTyping() && s.selection.length) s.rippleDeleteClips(s.selection)
      break
    case 'edit:select_all':
      if (isTyping()) document.execCommand('selectAll')
      else s.selectAllClips()
      break
    case 'view:safe_zones':
      s.setSafeZones(!s.safeZones)
      break
    case 'view:snap':
      s.setSnap(!s.snap)
      break
    case 'view:zoom_in':
      s.setPxPerSec(s.pxPerSec * 1.5)
      break
    case 'view:zoom_out':
      s.setPxPerSec(s.pxPerSec / 1.5)
      break
    case 'view:full_preview': {
      const next = !s.previewFull
      s.setPreviewFull(next)
      await invoke('set_preview_quality', { full: next }).catch(() => {})
      break
    }
    case 'view:pip_demo':
      await loadPipDemo()
      break
    // Dev-remote passthroughs (debug builds drive these via the trigger file).
    case 'dev:play':
      s.play()
      break
    case 'dev:pause':
      s.pause()
      break
    case 'dev:reload':
      window.location.reload()
      break
    case 'dev:grade_demo': {
      // Keyframed grade on the fullscreen cam layer: exposure 0→2 and
      // saturation 0→-1 across 0..6s — Phase 3 animation verification.
      await loadPipDemo()
      const st = useStore.getState()
      const cam = st.project.tracks
        .filter((t) => t.kind === 'video')
        .sort((a, b) => b.z - a.z)[0]?.clips[0]
      if (!cam) break
      for (const prop of ['transform.scale', 'transform.x', 'transform.y', 'transform.cornerRadius'])
        st.clearKeyframes(cam.id, prop)
      st.setPlayhead(0)
      const gp = ensureFx(cam.id, 'grade')
      st.toggleKeyframe(cam.id, `${gp}exposure`)
      st.toggleKeyframe(cam.id, `${gp}saturation`)
      st.setPlayhead(6)
      st.setClipProperty(cam.id, `${gp}exposure`, 2)
      st.setClipProperty(cam.id, `${gp}saturation`, -1)
      st.setPlayhead(0.5)
      break
    }
    case 'dev:p5_select_test': {
      // Phase 5 item 1 check: marquee via real pointer events on the lane DOM,
      // group drag via a real drag on a clip block, collision rejection via
      // moveClipsTo. Reports through report_test like the other self-tests.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p5-select', pass, detail }).catch(() => {})
      try {
        await loadPipDemo()
        await new Promise((r) => setTimeout(r, 300))
        const st = () => useStore.getState()
        st().pause()
        st().setPlayhead(0)
        st().select([])
        const vids = st()
          .project.tracks.filter((t) => t.kind === 'video')
          .flatMap((t) => t.clips.map((c) => c.id))
        const [aId, bId] = vids
        st().moveClip(bId, 1) // create a nonzero offset between the two clips
        const pe = (type: string, x: number, y: number) =>
          new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true })
        // -- marquee: start on empty lane space right of the clips, drag left
        const lanes = Array.from(document.querySelectorAll<HTMLElement>('[data-lane-track]'))
        const l0 = lanes[0].getBoundingClientRect()
        const l1 = lanes[1].getBoundingClientRect()
        lanes[0].dispatchEvent(pe('pointerdown', l0.left + 700, l0.top + 4))
        window.dispatchEvent(pe('pointermove', l0.left + 100, l1.bottom - 4))
        window.dispatchEvent(pe('pointerup', l0.left + 100, l1.bottom - 4))
        const marqueeOk = st().selection.includes(aId) && st().selection.includes(bId)
        // -- group drag: real drag on clip A's block, +120px = +2s at 60px/s
        const aStart0 = 0
        const bStart0 = 1
        const clipEl = document.querySelector<HTMLElement>(`[data-clip-id="${aId}"]`)!
        const cr = clipEl.getBoundingClientRect()
        const cx = cr.left + cr.width / 2
        const cy = cr.top + cr.height / 2
        clipEl.dispatchEvent(pe('pointerdown', cx, cy))
        window.dispatchEvent(pe('pointermove', cx + 60, cy))
        window.dispatchEvent(pe('pointermove', cx + 120, cy))
        window.dispatchEvent(pe('pointerup', cx + 120, cy))
        const find = (id: string) =>
          st()
            .project.tracks.flatMap((t) => t.clips)
            .find((c) => c.id === id)!
        const aStart1 = find(aId).start
        const bStart1 = find(bId).start
        const dragOk =
          Math.abs(aStart1 - (aStart0 + 2)) < 0.05 &&
          Math.abs(bStart1 - aStart1 - (bStart0 - aStart0)) < 0.001
        // -- collision rejection: split A, try to shove left piece into right
        st().splitClip(aId, aStart1 + 1)
        const leftPiece = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.id === aId)!
        st().moveClipsTo([
          { id: leftPiece.id, start: leftPiece.start + 0.5 },
          { id: bId, start: bStart1 + 0.5 },
        ])
        const rejected =
          find(leftPiece.id).start === leftPiece.start && find(bId).start === bStart1
        void report(
          marqueeOk && dragOk && rejected,
          `marquee=${marqueeOk} groupDrag=${dragOk} (a ${aStart1.toFixed(2)} b ${bStart1.toFixed(2)}) reject=${rejected}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p5_marker_test': {
      // Phase 5 item 2 check: M shortcut through the real keydown path, DOM
      // flags/labels on the ruler, rename, right-click delete.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p5-markers', pass, detail }).catch(() => {})
      const tick = () => new Promise((r) => setTimeout(r, 80))
      try {
        await loadPipDemo()
        await tick()
        const st = () => useStore.getState()
        st().pause()
        const key = () =>
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }))
        st().setPlayhead(2)
        key()
        st().setPlayhead(4)
        key()
        key() // duplicate at same frame must dedupe
        await tick()
        const ms = st().project.markers ?? []
        const added =
          ms.length === 2 && Math.abs(ms[0].t - 2) < 0.05 && Math.abs(ms[1].t - 4) < 0.05
        const domOk = document.querySelectorAll('.tl__marker').length === 2
        st().renameMarker(ms[0].id, 'Intro')
        await tick()
        const renamed = Array.from(document.querySelectorAll('.tl__marker-label')).some(
          (el) => el.textContent === 'Intro',
        )
        document
          .querySelector('.tl__marker')!
          .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        await tick()
        const deleted = (st().project.markers ?? []).length === 1
        void report(
          added && domOk && renamed && deleted,
          `added=${added} dom=${domOk} renamed=${renamed} deleted=${deleted}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p5_freeze_test': {
      // Phase 5 item 3 check: freeze the top demo clip at t=2, park the still
      // at t=12 (past the 10s sources) so a later native capture can only show
      // content if the PNG is really decoding through the compositor.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p5-freeze', pass, detail }).catch(() => {})
      try {
        await loadPipDemo()
        await new Promise((r) => setTimeout(r, 300))
        const st = () => useStore.getState()
        st().pause()
        st().setPlayhead(2)
        const topClip = st()
          .project.tracks.filter((t) => t.kind === 'video')
          .sort((a, b) => b.z - a.z)[0].clips[0]
        const { freezeFrame } = await import('../persistence/projectIO')
        await freezeFrame(topClip.id)
        const still = st().project.media.find((m) => m.name.includes('(freeze)'))
        const stillClip = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.mediaId === still?.id)
        if (!still || !stillClip) {
          void report(false, `asset=${!!still} clip=${!!stillClip}`)
          break
        }
        st().moveClip(stillClip.id, 12)
        st().setPlayhead(13)
        const moved = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.id === stillClip.id)!
        void report(
          (still.width ?? 0) > 0 && moved.start === 12 && st().project.duration === 15,
          `png=${still.path} ${still.width}x${still.height} clipAt=${moved.start} dur=${st().project.duration}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p5_adjust_demo': {
      // Phase 5 item 4 scene: adjustment layer (sat -1, exposure +0.6) over
      // the PiP demo from t=2..6 — capture inside vs outside the span.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p5-adjust', pass, detail }).catch(() => {})
      try {
        await loadPipDemo()
        await new Promise((r) => setTimeout(r, 300))
        const st = () => useStore.getState()
        st().pause()
        st().setPlayhead(2)
        const before = st().project.tracks.filter((t) => t.kind === 'video').length
        st().addAdjustmentLayer()
        const adj = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.adjust)
        if (!adj) {
          void report(false, 'no adjustment clip created')
          break
        }
        const ap = ensureFx(adj.id, 'grade')
        st().setClipProperty(adj.id, `${ap}saturation`, -1)
        st().setClipProperty(adj.id, `${ap}exposure`, 0.6)
        st().setPlayhead(3)
        const after = st().project.tracks.filter((t) => t.kind === 'video').length
        void report(
          after === before + 1 && adj.start === 2,
          `newTrack=${after > before} start=${adj.start} span=[2,6)`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p5_thumb_test': {
      // Phase 5 item 5 check: strip extraction (20 tiles), then a real
      // pointermove over a clip must float the thumb with the right tile
      // offset; pointerleave must remove it.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p5-thumb', pass, detail }).catch(() => {})
      const tick = (ms = 120) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await tick(300)
        const st = useStore.getState()
        st.pause()
        const asset = st.project.media.find((m) => m.name === 'cam.mp4')!
        const { getFilmstrip } = await import('../engine/filmstrip')
        const strip = await getFilmstrip(asset)
        if (!strip) {
          void report(false, 'no strip extracted')
          break
        }
        const clip = st.project.tracks
          .filter((t) => t.kind === 'video')
          .sort((a, b) => b.z - a.z)[0].clips[0]
        const el = document.querySelector<HTMLElement>(`[data-clip-id="${clip.id}"]`)!
        const rect = el.getBoundingClientRect()
        const mv = (fx: number) =>
          el.dispatchEvent(
            new PointerEvent('pointermove', {
              clientX: rect.left + rect.width * fx,
              clientY: rect.top + rect.height / 2,
              bubbles: true,
            }),
          )
        mv(0.8) // first move arms the async strip fetch (already cached now)
        await tick()
        mv(0.8)
        await tick()
        const thumb = document.querySelector<HTMLElement>('.clip__thumb')
        const posLate = thumb?.style.backgroundPositionX ?? 'none'
        mv(0.1)
        await tick()
        const posEarly =
          document.querySelector<HTMLElement>('.clip__thumb')?.style.backgroundPositionX ?? 'none'
        // React synthesizes onPointerLeave from bubbling pointerout + an
        // outside relatedTarget — same as a real mouse.
        el.dispatchEvent(
          new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
        )
        await tick()
        const gone = !document.querySelector('.clip__thumb')
        void report(
          !!thumb && posLate !== posEarly && gone,
          `strip=${strip.frames}f ${strip.frameW}x${strip.h} late=${posLate} early=${posEarly} gone=${gone}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p5_thumb_show': {
      // Leave a hover thumb on screen for a native capture.
      await loadPipDemo()
      await new Promise((r) => setTimeout(r, 300))
      const st = useStore.getState()
      st.pause()
      const asset = st.project.media.find((m) => m.name === 'cam.mp4')!
      const { getFilmstrip } = await import('../engine/filmstrip')
      await getFilmstrip(asset)
      const clip = st.project.tracks
        .filter((t) => t.kind === 'video')
        .sort((a, b) => b.z - a.z)[0].clips[0]
      const el = document.querySelector<HTMLElement>(`[data-clip-id="${clip.id}"]`)!
      const rect = el.getBoundingClientRect()
      for (let i = 0; i < 2; i++) {
        el.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: rect.left + rect.width * 0.6,
            clientY: rect.top + rect.height / 2,
            bubbles: true,
          }),
        )
        await new Promise((r) => setTimeout(r, 150))
      }
      break
    }
    case 'dev:p1_shell_test': {
      // Phase 1 (session 9): license lifecycle, settings, recents thumbnail.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p1-shell', pass, detail }).catch(() => {})
      try {
        await invoke('deactivate_license')
        const off = !(await invoke<boolean>('license_status'))
        let badKeyRejected = false
        try {
          await invoke('activate_license', { key: 'MOTIONAIRE-WRONG-1111-2222' })
        } catch {
          badKeyRejected = true
        }
        const stillOff = !(await invoke<boolean>('license_status'))
        await invoke('activate_license', { key: 'MOTIONAIRE-TEST-0000-0000' })
        const on = await invoke<boolean>('license_status')
        await invoke('set_setting', { key: 'onboarding_completed', value: '1' })
        const flag = await invoke<string | null>('get_setting', { key: 'onboarding_completed' })
        // Recents thumbnail: save the demo project programmatically.
        await loadPipDemo()
        await new Promise((r) => setTimeout(r, 800)) // let a frame land for the thumb
        const spike = useStore.getState().project.media[0]?.path ?? ''
        const dir = spike.slice(0, spike.lastIndexOf('/'))
        useStore.getState().setProjectPath(`${dir}/shell-e2e.motionaire`)
        const { saveProject } = await import('../persistence/projectIO')
        const saved = await saveProject()
        const recents = await invoke<
          { path: string; name: string; thumbnail: string | null; missing: boolean }[]
        >('list_recent_projects')
        const mine = recents.find((r) => r.path.endsWith('shell-e2e.motionaire'))
        const thumbOk = !!mine && !mine.missing && !!mine.thumbnail
        void report(
          off && badKeyRejected && stillOff && on && flag === '1' && saved && thumbOk,
          `off=${off} badKeyRejected=${badKeyRejected} stillOff=${stillOff} on=${on} flag=${flag} saved=${saved} thumb=${mine?.thumbnail ?? 'none'}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p2_bin_test': {
      // Phase 2 (session 9): bin lists media, real DnD drop places a clip at
      // the drop time, removeMedia sweeps clips, relink data path verified
      // through updateMedia.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p2-bin', pass, detail }).catch(() => {})
      const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await tick(300)
        const st = () => useStore.getState()
        st().pause()
        const listed = document.querySelectorAll('.bin__item').length
        // Real drag-and-drop: bin item → V2 lane at ~12s (past the 10s clips).
        const item = document.querySelector<HTMLElement>('.bin__item')!
        const lane = document.querySelector<HTMLElement>('[data-lane-track]')!
        const laneRect = lane.getBoundingClientRect()
        const dt = new DataTransfer()
        item.dispatchEvent(
          new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }),
        )
        const dropX = laneRect.left + 12 * 60 // 12s at 60px/s, scrollLeft 0
        lane.dispatchEvent(
          new DragEvent('dragover', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: dropX,
            clientY: laneRect.top + 10,
          }),
        )
        lane.dispatchEvent(
          new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
            clientX: dropX,
            clientY: laneRect.top + 10,
          }),
        )
        await tick()
        const clipsAfterDrop = st().project.tracks.flatMap((t) => t.clips).length
        const dropped = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => Math.abs(c.start - 12) < 0.5)
        // removeMedia: nukes the asset and every clip using it
        const victim = st().project.media[0]
        const before = st().project.tracks.flatMap((t) => t.clips).length
        st().removeMedia(victim.id)
        const after = st().project.tracks.flatMap((t) => t.clips).length
        const mediaGone = !st().project.media.some((m) => m.id === victim.id)
        void report(
          listed === 2 && clipsAfterDrop === 3 && !!dropped && mediaGone && after < before,
          `listed=${listed} clipsAfterDrop=${clipsAfterDrop} droppedAt=${dropped?.start} mediaGone=${mediaGone} clips ${before}→${after}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p3_tracks_test': {
      // Phase 3 (session 9): add/rename/lock/reorder/hide tracks. The hide
      // check finishes visually: a follow-up native capture must show no PiP.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p3-tracks', pass, detail }).catch(() => {})
      const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await tick(300)
        const st = () => useStore.getState()
        st().pause()
        st().addTrack('video')
        const vids = () => st().project.tracks.filter((t) => t.kind === 'video')
        const v3 = vids().find((t) => t.name === 'V3')
        const added = vids().length === 3 && !!v3 && v3.z === 2
        st().renameTrack(v3!.id, 'Overlay')
        await tick()
        const renamedDom = Array.from(document.querySelectorAll('.th__name')).some(
          (el) => el.textContent === 'Overlay',
        )
        // Lock: every edit against the cam clip must bounce.
        const cam = vids()
          .filter((t) => t.clips.length > 0)
          .sort((a, b) => b.z - a.z)[0]
        const camClip = cam.clips[0]
        const startBefore = camClip.start
        const scaleBefore = camClip.transform.scale
        st().setTrackFlag(cam.id, 'locked', true)
        st().moveClip(camClip.id, 5)
        st().deleteClips([camClip.id])
        st().setClipProperty(camClip.id, 'transform.scale', 0.33)
        const after = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.id === camClip.id)
        const lockHeld =
          !!after && after.start === startBefore && after.transform.scale === scaleBefore
        st().setTrackFlag(cam.id, 'locked', false)
        // Reorder: swap display order with the neighbor and back.
        const zBefore = cam.z
        st().reorderTrack(cam.id, 1)
        const zAfter = st().project.tracks.find((t) => t.id === cam.id)!.z
        st().reorderTrack(cam.id, -1)
        const zBack = st().project.tracks.find((t) => t.id === cam.id)!.z
        const reordered = zAfter !== zBefore && zBack === zBefore
        // Hide the cam track and park at t=3 — capture must show no PiP.
        st().setTrackFlag(cam.id, 'hidden', true)
        st().setPlayhead(3)
        void report(
          added && renamedDom && lockHeld && reordered,
          `added=${added} renamedDom=${renamedDom} lockHeld=${lockHeld} reorder=${zBefore}→${zAfter}→${zBack} camHidden=true`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p4_text_test': {
      // Phase 4 (session 9): a styled text clip must reach the COMPOSITED
      // frame (DOM overlay is hidden while the compositor is active). The
      // follow-up captures prove presence, keyframe animation, and that
      // hiding the track removes it from the canvas.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p4-text', pass, detail }).catch(() => {})
      try {
        await loadPipDemo()
        await new Promise((r) => setTimeout(r, 300))
        const st = () => useStore.getState()
        st().pause()
        st().setPlayhead(3)
        st().addTrack('video') // free topmost lane — V2 is fully occupied
        st().addTextClip('Compositor Text')
        const txt = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.kind === 'text')
        if (!txt) {
          void report(false, 'no text clip created')
          break
        }
        st().updateTextClip(txt.id, {
          style: { size: 110, color: '#ffcc00', stroke: { color: '#000000', width: 5 } },
        })
        // Debounced sync (60ms) + raster + IPC + a render.
        await new Promise((r) => setTimeout(r, 700))
        const overlayHidden =
          st().compositorActive && !document.querySelector('.preview__text')
        void report(
          overlayHidden,
          `clip=${txt.id} start=${txt.start} overlayHidden=${overlayHidden} (visual proof via captures)`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p5_export_test': {
      // Phase 5 (session 9): build the full verification scene from the plan
      // — keyframed PiP, a dissolve, a text clip, an image overlay, a color
      // grade, and audio with a keyframed fade — then export it for real.
      // The exported FILE is then verified element by element from the shell.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p5-export', pass, detail }).catch(() => {})
      const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await tick(300)
        const st = () => useStore.getState()
        st().pause()
        const vids = () =>
          st().project.tracks.filter((t) => t.kind === 'video').sort((a, b) => a.z - b.z)
        const screenClip = vids()[0].clips[0] // V1 fullscreen screen.mp4
        // Transition: split the screen layer at 5s, dissolve into the second half.
        st().splitClip(screenClip.id, 5)
        const secondHalf = vids()[0].clips.find((c) => Math.abs(c.start - 5) < 0.01)!
        st().setTransition(secondHalf.id, 'in', { type: 'dissolve', duration: 1.2 })
        // Grade the first half: clearly desaturated.
        st().setClipProperty(screenClip.id, `${ensureFx(screenClip.id, 'grade')}saturation`, -0.6)
        // Text on its own new top track, 1s..4s.
        st().addTrack('video')
        st().setPlayhead(1)
        st().addTextClip('Export Test')
        const txt = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.kind === 'text')!
        st().updateTextClip(txt.id, {
          style: { size: 100, color: '#ffffff', stroke: { color: '#000000', width: 5 } },
        })
        // Image overlay: freeze the cam at t=2, park the still 5s..8s, shrink
        // to a corner card.
        const cam = vids()[1].clips[0]
        st().setPlayhead(2)
        const { freezeFrame } = await import('../persistence/projectIO')
        await freezeFrame(cam.id)
        const still = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.mediaId && st().project.media.find((m) => m.id === c.mediaId)?.name.includes('(freeze)'))!
        st().moveClip(still.id, 5)
        st().setClipProperty(still.id, 'transform.scale', 0.3)
        st().setClipProperty(still.id, 'transform.x', 560)
        st().setClipProperty(still.id, 'transform.y', -280)
        // Audio: 440Hz tone on A1, keyframed fade 6s→9.5s.
        const tonePath = await invoke<string>('spike_audio')
        const { uid: mkid } = await import('../types/project')
        const { convertFileSrc } = await import('@tauri-apps/api/core')
        st().addMedia({
          id: mkid('m'),
          path: tonePath,
          playbackUrl: convertFileSrc(tonePath),
          name: 'tone.wav',
          kind: 'audio',
          duration: 10,
          hasAudio: true,
        })
        const tone = st().project.media.find((m) => m.name === 'tone.wav')!
        st().insertClipAt(tone.id, null, 0)
        const toneClip = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.mediaId === tone.id)!
        st().setPlayhead(6)
        st().toggleKeyframe(toneClip.id, 'volume')
        st().setPlayhead(9.5)
        st().setClipProperty(toneClip.id, 'volume', 0)
        await tick(400) // let rasters + structure sync
        const { runExport } = await import('../compositor/exportRunner')
        const out = await runExport('/tmp/motionaire-export-test.mp4')
        void report(
          out === '/tmp/motionaire-export-test.mp4',
          `started export → ${out}; duration=${st().project.duration}s; completion + file verification happen shell-side`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p5_cancel_test': {
      // Break-test: cancel mid-export → export:done{cancelled}, partial file
      // removed, and a follow-up export still works.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p5-cancel', pass, detail }).catch(() => {})
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const { runExport } = await import('../compositor/exportRunner')
        const done = new Promise<{ ok: boolean; cancelled?: boolean }>((resolve) => {
          void listen<{ ok: boolean; cancelled?: boolean }>('export:done', (e) =>
            resolve(e.payload),
          ).then((un) => setTimeout(un, 30000))
        })
        await runExport('/tmp/motionaire-cancel-test.mp4')
        setTimeout(() => void invoke('cancel_export'), 500)
        const result = await done
        await new Promise((r) => setTimeout(r, 300))
        // Partial file must be gone; a fresh export must be startable.
        let fileGone = true
        try {
          await invoke('probe_media', { path: '/tmp/motionaire-cancel-test.mp4' })
          fileGone = false
        } catch {
          fileGone = true
        }
        void report(
          !result.ok && result.cancelled === true && fileGone,
          `ok=${result.ok} cancelled=${result.cancelled} partialRemoved=${fileGone}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p6_safety_test': {
      // Phase 6 (session 9): dirty lifecycle, autosave recovery round-trip,
      // clip clipboard (copy/cut/paste incl. DOM ClipboardEvent path).
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p6-safety', pass, detail }).catch(() => {})
      const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await tick(300)
        const st = () => useStore.getState()
        st().pause()
        // -- dirty lifecycle: demo load marks dirty; save clears it
        const dirtyAfterEdit = st().dirty
        const spike = st().project.media[0].path
        const dir = spike.slice(0, spike.lastIndexOf('/'))
        st().setProjectPath(`${dir}/safety-e2e.motionaire`)
        const { saveProject, serializeProject } = await import('../persistence/projectIO')
        await saveProject()
        const cleanAfterSave = !st().dirty
        // -- autosave recovery: mutate, write recovery, reload → offer accepted?
        // confirm() would block; instead verify the Rust round-trip directly.
        st().moveClip(st().project.tracks.flatMap((t) => t.clips)[0].id, 2)
        await new Promise((r) => setTimeout(r, 1100)) // recovery mtime > project.json mtime (1s resolution)
        await invoke('save_recovery', {
          bundlePath: `${dir}/safety-e2e.motionaire`,
          projectJson: serializeProject(st().project),
        })
        const loaded = await invoke<{ recoveryJson: string | null }>('load_project', {
          bundlePath: `${dir}/safety-e2e.motionaire`,
          name: 'safety-e2e',
        })
        const recoveryOffered = !!loaded.recoveryJson
        const recoveredProject = loaded.recoveryJson
          ? (JSON.parse(loaded.recoveryJson) as { tracks: { clips: { start: number }[] }[] })
          : null
        const recoveryHasEdit = !!recoveredProject?.tracks.some((t) =>
          t.clips.some((c) => c.start === 2),
        )
        // explicit save clears recovery
        await saveProject()
        const loaded2 = await invoke<{ recoveryJson: string | null }>('load_project', {
          bundlePath: `${dir}/safety-e2e.motionaire`,
          name: 'safety-e2e',
        })
        const recoveryCleared = !loaded2.recoveryJson
        // -- clipboard: copy/paste preserves state; cut removes; DOM event path
        const src = st().project.tracks.flatMap((t) => t.clips)[0]
        st().setClipProperty(src.id, `${ensureFx(src.id, 'grade')}saturation`, -0.4)
        st().select([src.id])
        document.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true }))
        const copied = st().clipboard.length === 1
        st().setPlayhead(12)
        st().pasteAtPlayhead()
        const pasted = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => Math.abs(c.start - 12) < 0.05 && c.id !== src.id)
        const pasteKeepsState =
          !!pasted &&
          pasted.effects.find((e) => e.type === 'grade')?.params.saturation === -0.4
        const before = st().project.tracks.flatMap((t) => t.clips).length
        st().cutClips([pasted!.id])
        const cutRemoved =
          st().project.tracks.flatMap((t) => t.clips).length === before - 1 &&
          st().clipboard.length === 1
        void report(
          dirtyAfterEdit &&
            cleanAfterSave &&
            recoveryOffered &&
            recoveryHasEdit &&
            recoveryCleared &&
            copied &&
            pasteKeepsState &&
            cutRemoved,
          `dirty=${dirtyAfterEdit} cleanAfterSave=${cleanAfterSave} recovery=${recoveryOffered}/${recoveryHasEdit} cleared=${recoveryCleared} copyEvent=${copied} pasteState=${pasteKeepsState} cut=${cutRemoved}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p7_test': {
      // Phase 7 (session 9): speed ramp math + fades + ducking windows +
      // shape clip. Ramp gets visual proof via the demo's burned-in timecode
      // (captured after this test parks the playhead at t=4).
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p7-batch', pass, detail }).catch(() => {})
      const tick = (ms = 200) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await tick(300)
        const st = () => useStore.getState()
        st().pause()
        const { sourceTime, clipDuration } = await import('../engine/time')
        // -- speed ramp on the cam clip: kf (0,1) → (4,3); ∫ at rel 4 = 8.
        const cam = st()
          .project.tracks.filter((t) => t.kind === 'video')
          .sort((a, b) => b.z - a.z)[0].clips[0]
        for (const prop of ['transform.scale', 'transform.x', 'transform.y', 'transform.cornerRadius'])
          st().clearKeyframes(cam.id, prop) // fullscreen so the timecode is readable
        st().setPlayhead(0)
        st().toggleKeyframe(cam.id, 'speed')
        st().setPlayhead(4)
        st().setClipProperty(cam.id, 'speed', 3)
        const camNow = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.id === cam.id)!
        const rampSrc = sourceTime(camNow, 4)
        const rampOk = Math.abs(rampSrc - 8) < 0.05
        // -- fades on a tone clip
        const tonePath = await invoke<string>('spike_audio', { pattern: null })
        const { uid: mkid } = await import('../types/project')
        const { convertFileSrc } = await import('@tauri-apps/api/core')
        st().addMedia({
          id: mkid('m'),
          path: tonePath,
          playbackUrl: convertFileSrc(tonePath),
          name: 'tone.wav',
          kind: 'audio',
          duration: 10,
          hasAudio: true,
        })
        const tone = st().project.media.find((m) => m.name === 'tone.wav')!
        st().insertClipAt(tone.id, null, 0)
        const toneClip = () =>
          st()
            .project.tracks.flatMap((t) => t.clips)
            .find((c) => c.mediaId === tone.id)!
        st().addFade(toneClip().id, 'in')
        st().addFade(toneClip().id, 'out')
        const vkfs = toneClip().keyframes.filter((k) => k.prop === 'volume')
        const D = clipDuration(toneClip())
        const fadesOk =
          vkfs.some((k) => k.t === 0 && k.v === 0) &&
          vkfs.some((k) => Math.abs(k.t - 0.5) < 0.05 && k.v === 1) &&
          vkfs.some((k) => Math.abs(k.t - (D - 0.5)) < 0.05 && k.v === 1) &&
          vkfs.some((k) => Math.abs(k.t - D) < 0.05 && k.v === 0)
        // -- ducking: gapped "speech" on a second audio track ducks the tone
        st().applyDuckingEnvelope(toneClip().id, []) // clear fade kfs for a clean read
        const gappedPath = await invoke<string>('spike_audio', { pattern: 'gapped' })
        st().addMedia({
          id: mkid('m'),
          path: gappedPath,
          playbackUrl: convertFileSrc(gappedPath),
          name: 'speech.wav',
          kind: 'audio',
          duration: 10,
          hasAudio: true,
        })
        st().addTrack('audio')
        const speech = st().project.media.find((m) => m.name === 'speech.wav')!
        const a2 = st().project.tracks.filter((t) => t.kind === 'audio').pop()!
        st().insertClipAt(speech.id, a2.id, 0)
        const { duckUnderSpeech } = await import('../engine/ducking')
        const windows = await duckUnderSpeech(toneClip().id)
        const duckKfs = toneClip().keyframes.filter((k) => k.prop === 'volume')
        const duckOk = windows >= 3 && duckKfs.some((k) => Math.abs(k.v - 0.25) < 0.01)
        // -- shape: red ellipse at playhead 4 (grows its own track)
        st().addShapeClip('ellipse')
        const shapeClip = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.shape)!
        st().updateShape(shapeClip.id, { fill: '#e04545', width: 500, height: 300 })
        await tick(500) // raster + sync
        void report(
          rampOk && fadesOk && duckOk,
          `rampSrc(t=4)=${rampSrc.toFixed(2)} (want 8) fades=${fadesOk} duckWindows=${windows} duckKf=${duckOk} shape=${!!shapeClip}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:f0_popover_test': {
      // Foundation Phase 0: the popover CLASS fix. The Add menu (bottom
      // toolbar) must flip upward fully in-view with its last item (Line)
      // reachable; a context menu invoked at the bottom-right corner must be
      // shifted fully into the viewport.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'f0-popover', pass, detail }).catch(() => {})
      const tick = (ms = 150) => new Promise((r) => setTimeout(r, ms))
      try {
        // Fresh-boot isolation: the editor must be mounted before its DOM
        // can be poked (the suite reloads the webview per test).
        await loadPipDemo()
        await tick(400)
        const btn = document.querySelector<HTMLElement>('.tl__toolbar .iconbtn')!
        btn.dispatchEvent(
          new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
        )
        await tick()
        const pop = document.querySelector<HTMLElement>('.popover')
        if (!pop) {
          void report(false, 'Add popover did not open')
          break
        }
        const r = pop.getBoundingClientRect()
        const b = btn.getBoundingClientRect()
        const inView =
          r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth
        const items = Array.from(pop.querySelectorAll('.menu__item')).map(
          (el) => el.textContent ?? '',
        )
        const lineEl = Array.from(pop.querySelectorAll<HTMLElement>('.menu__item')).find(
          (el) => el.textContent === 'Line',
        )
        const lineVisible =
          !!lineEl &&
          lineEl.getBoundingClientRect().bottom <= window.innerHeight &&
          lineEl.getBoundingClientRect().top >= 0
        const flippedUp = r.bottom <= b.top + 1
        // capture happens while this menu is open (dev remote follows up)
        window.setTimeout(() => {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        }, 6000)
        void report(
          inView && lineVisible && flippedUp,
          `inView=${inView} flippedUp=${flippedUp} lineVisible=${lineVisible} items=${items.length}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:f0_ctx_test': {
      // Part 2: context menu at the extreme bottom-right corner stays in view.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'f0-ctx', pass, detail }).catch(() => {})
      try {
        // Fresh-boot isolation: mount the editor first (suite reloads per test).
        await loadPipDemo()
        await new Promise((r) => setTimeout(r, 400))
        const lane = document.querySelector<HTMLElement>('[data-lane-track]')!
        lane.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: window.innerWidth - 12,
            clientY: window.innerHeight - 12,
          }),
        )
        await new Promise((r) => setTimeout(r, 150))
        const pop = document.querySelector<HTMLElement>('.popover')
        if (!pop) {
          void report(false, 'context popover did not open')
          break
        }
        const r = pop.getBoundingClientRect()
        const inView =
          r.top >= 0 &&
          r.bottom <= window.innerHeight &&
          r.left >= 0 &&
          r.right <= window.innerWidth
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
        void report(inView, `rect=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.right)},${Math.round(r.bottom)} vp=${window.innerWidth}x${window.innerHeight}`)
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:f1_parity_test': {
      // Foundation Phase 1: TS display mirror vs the PRODUCTION Rust resolver
      // over a torture fixture — every easing, multi-kf curves, statics,
      // grade, and a speed ramp, sampled densely including out-of-range times.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'f1-parity', pass, detail }).catch(() => {})
      try {
        await loadPipDemo()
        await new Promise((r) => setTimeout(r, 300))
        const st = () => useStore.getState()
        st().pause()
        const { resolveProp } = await import('../engine/keyframes')
        const { sourceTime } = await import('../engine/time')
        const { flatten } = await import('../compositor/bridge')
        const vids = st()
          .project.tracks.filter((t) => t.kind === 'video')
          .sort((a, b) => b.z - a.z)
        const cam = vids[0].clips[0]
        const screen = vids[1].clips[0]
        // Torture fixture: mutate the FLATTENED payload directly — the probe
        // consumes the payload and the TS mirror resolves the same payload,
        // so both sides see byte-identical inputs without fighting the
        // store's stopwatch semantics.
        const payload = flatten(st().project)
        const camL = payload.layers.find((l) => l.id === cam.id)!
        const scrL = payload.layers.find((l) => l.id === screen.id)!
        camL.keyframes = [
          { prop: 'transform.x', t: 0, v: -400, ease: 'linear' },
          { prop: 'transform.x', t: 3.7, v: 400, ease: 'linear' },
          { prop: 'transform.y', t: 0.3, v: -200, ease: 'easeIn' },
          { prop: 'transform.y', t: 5.1, v: 260, ease: 'easeIn' },
          { prop: 'transform.scale', t: 0, v: 1, ease: 'easeInOut' },
          { prop: 'transform.scale', t: 1.2, v: 0.1, ease: 'easeInOut' },
          { prop: 'transform.scale', t: 6.4, v: 0.8, ease: 'easeOut' },
          { prop: 'transform.rotation', t: 1, v: 0, ease: 'spring' },
          { prop: 'transform.rotation', t: 8, v: 180, ease: 'spring' },
          { prop: 'transform.opacity', t: 0, v: 1, ease: 'easeOut' },
          { prop: 'transform.opacity', t: 9.9, v: 0.2, ease: 'easeOut' },
          { prop: 'transform.cornerRadius', t: 2, v: 0, ease: 'easeInOut' },
          { prop: 'transform.cornerRadius', t: 2.01, v: 64, ease: 'easeInOut' },
          { prop: 'fx.pg.exposure', t: 0, v: -1, ease: 'easeInOut' },
          { prop: 'fx.pg.exposure', t: 7, v: 1.5, ease: 'easeInOut' },
          { prop: 'fx.pg.saturation', t: 4, v: 0, ease: 'linear' },
          { prop: 'fx.pg.saturation', t: 9, v: -1, ease: 'linear' },
        ]
        // Stack instance the fx.pg.* keyframes address (Phase 2 model).
        ;(camL as unknown as { stack: unknown[] }).stack = [
          { id: 'pg', type: 'grade', enabled: true, params: { exposure: 0, saturation: 0 } },
        ]
        scrL.keyframes = [
          { prop: 'speed', t: 0, v: 0.5, ease: 'linear' },
          { prop: 'speed', t: 4, v: 2.5, ease: 'linear' },
          { prop: 'speed', t: 8, v: 1, ease: 'linear' },
        ]
        const times: number[] = []
        for (let t = -0.5; t <= 12; t += 0.37) times.push(Number(t.toFixed(4)))
        const samples = await invoke<
          {
            id: string
            t: number
            x: number
            y: number
            scale: number
            rotation: number
            opacity: number
            cornerRadius: number
            fx0: [number, number]
            grade: number[]
            srcT: number
          }[]
        >('resolve_parity_probe', { project: payload, times })
        // TS mirror over the same payload (adapt flattened layer → Clip shape).
        const asClip = (l: typeof camL) =>
          ({
            id: l.id,
            kind: 'video',
            start: l.start,
            in: l.in,
            out: l.out,
            speed: l.speed,
            volume: 1,
            transform: l.transform,
            keyframes: l.keyframes,
            transitions: { in: null, out: null },
            effects: (l as { stack?: import('../types/project').Effect[] }).stack ?? [],
          }) as unknown as import('../types/project').Clip
        let worst = 0
        let worstAt = ''
        const check = (a: number, b: number, label: string) => {
          const d = Math.abs(a - b)
          if (d > worst) {
            worst = d
            worstAt = label
          }
        }
        for (const smp of samples) {
          const l = smp.id === cam.id ? camL : smp.id === screen.id ? scrL : null
          if (!l) continue
          const clip = asClip(l)
          const rel = smp.t - l.start
          check(smp.x, resolveProp(clip, 'transform.x', rel), `x@${smp.t}`)
          check(smp.y, resolveProp(clip, 'transform.y', rel), `y@${smp.t}`)
          check(smp.scale, resolveProp(clip, 'transform.scale', rel), `scale@${smp.t}`)
          check(smp.rotation, resolveProp(clip, 'transform.rotation', rel), `rot@${smp.t}`)
          check(smp.opacity, resolveProp(clip, 'transform.opacity', rel), `op@${smp.t}`)
          check(
            smp.cornerRadius,
            resolveProp(clip, 'transform.cornerRadius', rel),
            `radius@${smp.t}`,
          )
          if (smp.id === cam.id) {
            // Chain op params: grade packs [exposure, contrast, ...] — p0/p1
            // are exposure and contrast; saturation checks via a 2nd probe
            // prop below (fx0[1] = contrast, unkeyed = 0 here, so pin
            // exposure exactly and saturation via the TS mirror both ways).
            check(smp.fx0[0], resolveProp(clip, 'fx.pg.exposure', rel), `exp@${smp.t}`)
          }
          check(smp.srcT, sourceTime(clip, smp.t), `srcT@${smp.t}`)
        }
        // f32 rounding on the Rust side bounds legitimate deltas; 2e-3 covers
        // rotation's 180-magnitude values at f32 precision.
        void report(worst < 2e-3, `worst=${worst.toExponential(2)} at ${worstAt}; samples=${samples.length}`)
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:f2_srcmon': {
      // Open the source monitor via the REAL bin double-click path and set an
      // in/out range for the capture.
      const item = document.querySelector<HTMLElement>('.bin__item')
      item?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 400))
      useStore.getState().setSourceRange('in', 2)
      useStore.getState().setSourceRange('out', 7)
      break
    }
    case 'dev:f2_edit_test': {
      // Foundation Phase 2: overwrite carves, insert ripples, source-range
      // insertion honors in/out, disable drops the layer, nudge moves by
      // exactly one frame, marks set/clear.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'f2-edit', pass, detail }).catch(() => {})
      try {
        await loadPipDemo()
        await new Promise((r) => setTimeout(r, 300))
        const st = () => useStore.getState()
        st().pause()
        const fps = st().project.canvas.fps
        const cam = st().project.media.find((m) => m.name === 'cam.mp4')!
        const v1 = st()
          .project.tracks.filter((t) => t.kind === 'video')
          .sort((a, b) => a.z - b.z)[0]
        // OVERWRITE a 2s range into the middle of the 10s screen clip → the
        // track becomes [0..4][4..6 new][6..10], still 3 clips, total 10s.
        st().setEditMode('overwrite')
        st().insertClipAt(cam.id, v1.id, 4, { in: 1, out: 3 })
        const clipsAfterOv = st().project.tracks.find((t) => t.id === v1.id)!.clips
        const sorted = [...clipsAfterOv].sort((a, b) => a.start - b.start)
        const ovOk =
          sorted.length === 3 &&
          Math.abs(sorted[0].start) < 0.01 &&
          Math.abs((sorted[0].out - sorted[0].in) / sorted[0].speed - 4) < 0.05 &&
          Math.abs(sorted[1].start - 4) < 0.01 &&
          sorted[1].mediaId === cam.id &&
          Math.abs(sorted[1].in - 1) < 0.01 &&
          Math.abs(sorted[1].out - 3) < 0.01 &&
          Math.abs(sorted[2].start - 6) < 0.01 &&
          Math.abs(st().project.duration - 10) < 0.05
        // INSERT the same 2s range at t=2 → everything after 2 shifts right
        // by 2; project grows to 12s.
        st().setEditMode('insert')
        st().insertClipAt(cam.id, v1.id, 2, { in: 1, out: 3 })
        const insOk = Math.abs(st().project.duration - 12) < 0.05
        // DISABLE: the inserted clip disappears from flatten
        const { flatten } = await import('../compositor/bridge')
        const target = [...st().project.tracks.find((t) => t.id === v1.id)!.clips].sort(
          (a, b) => a.start - b.start,
        )[1]
        const layersBefore = flatten(st().project).layers.length
        st().setClipDisabled([target.id], true)
        const layersAfter = flatten(st().project).layers.length
        const disableOk = layersAfter === layersBefore - 1
        st().setClipDisabled([target.id], false)
        // NUDGE: exactly one frame right on the LAST clip (open space to its
        // right — the packed middle correctly refuses, which is the collision
        // rule doing its job).
        const lastClip = [...st().project.tracks.find((t) => t.id === v1.id)!.clips].sort(
          (a, b) => a.start - b.start,
        )
        const tail = lastClip[lastClip.length - 1]
        st().select([tail.id])
        const s0 = tail.start
        st().nudgeSelection(1)
        const afterNudge = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.id === tail.id)!.start
        const nudgeOk = Math.abs(afterNudge - (s0 + 1 / fps)) < 1e-6
        st().nudgeSelection(-1)
        // MARKS: set via real keydown, out<in rejected
        st().setPlayhead(3)
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', bubbles: true }))
        st().setPlayhead(7)
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', bubbles: true }))
        const marksOk = st().markIn === 3 && st().markOut === 7
        st().setMarkOut(1) // invalid: out before in → in cleared per contract
        const marksGuard = st().markIn === null
        st().setMarkIn(3)
        st().setMarkOut(7)
        void report(
          ovOk && insOk && disableOk && nudgeOk && marksOk && marksGuard,
          `overwrite=${ovOk} insert=${insOk} disable=${disableOk} nudge=${nudgeOk} marks=${marksOk}/${marksGuard}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:f3_audio_test': {
      // Foundation Phase 3: live meters read signal, pan skews channels,
      // normalize computes the -1dB gain, master gain scales the bus.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'f3-audio', pass, detail }).catch(() => {})
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await wait(300)
        const st = () => useStore.getState()
        const { readPeaks, graphDebug } = await import('../engine/audioGraph')
        const { uid: mkid } = await import('../types/project')
        const { convertFileSrc } = await import('@tauri-apps/api/core')
        const tonePath = await invoke<string>('spike_audio', { pattern: null })
        st().addMedia({
          id: mkid('m'),
          path: tonePath,
          playbackUrl: convertFileSrc(tonePath),
          name: 'tone.wav',
          kind: 'audio',
          duration: 10,
          hasAudio: true,
        })
        const tone = st().project.media.find((m) => m.name === 'tone.wav')!
        st().insertClipAt(tone.id, null, 0)
        const toneClip = () =>
          st()
            .project.tracks.flatMap((t) => t.clips)
            .find((c) => c.mediaId === tone.id)!
        st().setPlayhead(1)
        st().play()
        // The wav element takes >1s to load+route on first play — poll until
        // signal actually reaches the master bus before baselining.
        let base = { l: 0, r: 0 }
        for (let i = 0; i < 40 && base.l < 0.05; i++) {
          await wait(150)
          base = readPeaks()
        }
        // The window is often OCCLUDED during unattended runs → WebKit
        // throttles rAF to ~1Hz and state changes reach the audio graph on a
        // slow tick. Poll for each effect instead of fixed sleeps.
        st().setClipProperty(toneClip().id, 'pan', -1)
        let panned = readPeaks()
        for (let i = 0; i < 30 && !(panned.l > 0.05 && panned.r < panned.l * 0.35); i++) {
          await wait(200)
          panned = readPeaks()
        }
        st().setClipProperty(toneClip().id, 'pan', 0)
        st().setMasterVolume(0.15)
        let quiet = readPeaks()
        for (let i = 0; i < 30 && !(quiet.l > 0.001 && quiet.l < base.l * 0.45); i++) {
          await wait(200)
          quiet = readPeaks()
        }
        const { lastPlaybackError } = await import('../engine/playback')
        const gainDbg = `mv=${st().project.masterVolume} ${graphDebug()} err=${lastPlaybackError ?? 'none'}`
        st().setMasterVolume(1)
        st().pause()
        // ffmpeg's sine source is ~1/8 full scale — thresholds sized to it.
        const metersOk = base.l > 0.05 && base.r > 0.05
        const panOk = panned.l > 0.05 && panned.r < panned.l * 0.35
        const masterOk = quiet.l < base.l * 0.45
        // normalize: expected gain derives from the SAME waveform the action
        // reads — assert the math, not an assumed source amplitude.
        const { getWaveform } = await import('../engine/waveform')
        const wf = (await getWaveform(tone))!
        const tc = toneClip()
        let peak = 0
        for (let i = Math.floor(tc.in * wf.pps); i < Math.min(wf.peaks.length, tc.out * wf.pps); i++)
          if (wf.peaks[i] > peak) peak = wf.peaks[i]
        await st().normalizeClip(tc.id)
        const v = toneClip().volume
        const expected = Math.min(4, 0.891 / Math.max(peak, 1e-4))
        const normOk = Math.abs(v - expected) < 0.02
        void report(
          metersOk && panOk && masterOk && normOk,
          `meters=${base.l.toFixed(2)}/${base.r.toFixed(2)} panned=${panned.l.toFixed(2)}/${panned.r.toFixed(2)} quiet=${quiet.l.toFixed(2)} normGain=${v.toFixed(3)} (want ${expected.toFixed(3)}, srcPeak=${peak.toFixed(3)}) graph[${gainDbg} | now ${graphDebug()}]`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:f4_fx_demo': {
      // Foundation Phase 4: apply key-less effects through the REAL store
      // (ellipse mask + vignette + blur on the cam layer, screen blend on it)
      // so the capture proves the frontend→flatten→compositor round trip.
      await loadPipDemo()
      await new Promise((r) => setTimeout(r, 300))
      const st = useStore.getState()
      st.pause()
      const cam = st.project.tracks
        .filter((t) => t.kind === 'video')
        .sort((a, b) => b.z - a.z)[0].clips[0]
      for (const prop of ['transform.scale', 'transform.x', 'transform.y', 'transform.cornerRadius'])
        st.clearKeyframes(cam.id, prop)
      const mp = ensureFx(cam.id, 'mask')
      const mid = mp.split('.')[1]
      st.updateEffectParams(cam.id, mid, {
        kind: 'ellipse', x: 0, y: 0, w: 800, h: 560, feather: 80, invert: false,
      })
      st.setClipProperty(cam.id, `${ensureFx(cam.id, 'vignette')}amount`, 0.6)
      st.setPlayhead(3)
      break
    }
    case 'dev:f5_proxy_test': {
      // Foundation Phase 5 — THE verification the plan demands: real 4K
      // footage (3840×2160, synthesized), TWO stacked streams, proxy
      // generated in background, preview flatten uses the proxy while export
      // flatten uses the original, and measured compositor capacity for
      // original vs proxy decode.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'f5-proxy', pass, detail }).catch(() => {})
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      try {
        const st = () => useStore.getState()
        const { flatten } = await import('../compositor/bridge')
        const { maybeRequestProxy } = await import('../persistence/proxyManager')
        const { uid: mkid } = await import('../types/project')
        const { convertFileSrc } = await import('@tauri-apps/api/core')
        const uhd = await invoke<string>('spike_4k') // may take a while first run
        const info = await invoke<{ width: number; height: number; duration: number }>(
          'probe_media',
          { path: uhd },
        )
        // Fresh project with TWO 4K streams: fullscreen + PiP on top.
        st().replaceProject((await import('../types/project')).createProject(), null)
        st().setAppView('editor')
        const asset = {
          id: mkid('m'),
          path: uhd,
          playbackUrl: convertFileSrc(uhd),
          name: 'uhd.mp4',
          kind: 'video' as const,
          duration: info.duration,
          width: info.width,
          height: info.height,
          hasAudio: false,
        }
        st().addMedia(asset)
        const tracks = st().project.tracks.filter((t) => t.kind === 'video')
        st().insertClipAt(asset.id, tracks[1].id, 0) // V1 fullscreen
        st().insertClipAt(asset.id, tracks[0].id, 0) // V2 PiP
        const pip = tracks[0].id
        const pipClip = st().project.tracks.find((t) => t.id === pip)!.clips[0]
        st().setClipProperty(pipClip.id, 'transform.scale', 0.3)
        st().setClipProperty(pipClip.id, 'transform.x', 500)
        st().setClipProperty(pipClip.id, 'transform.y', -280)
        // Baseline: ORIGINALS (the choke scenario) — play and sample capacity.
        st().setPreviewOriginal(true)
        st().setPlayhead(0.5)
        st().play()
        await wait(4000)
        const fpsOriginal = st().compositorFps
        st().pause()
        // Kick the proxy and wait for it to land (cache makes reruns instant).
        maybeRequestProxy(st().project.media[0])
        let proxyPath: string | undefined
        for (let i = 0; i < 240 && !proxyPath; i++) {
          await wait(500)
          proxyPath = st().project.media.find((m) => m.path === uhd)?.proxyPath
        }
        if (!proxyPath) {
          void report(false, 'proxy never landed (240 polls)')
          break
        }
        const pInfo = await invoke<{ width: number; height: number }>('probe_media', {
          path: proxyPath,
        })
        // THE RULE, asserted at flatten:
        const prevPaths = flatten(st().project).layers.map((l) => l.mediaPath)
        const expPaths = flatten(st().project, { originals: true }).layers.map(
          (l) => l.mediaPath,
        )
        const ruleOk =
          prevPaths.every((p) => p === proxyPath) && expPaths.every((p) => p === uhd)
        // Proxy playback capacity.
        st().setPreviewOriginal(false)
        st().setPlayhead(0.5)
        st().play()
        await wait(4000)
        const fpsProxy = st().compositorFps
        st().pause()
        const heightOk = pInfo.height === 720
        void report(
          heightOk && ruleOk && fpsProxy > 0,
          `src=${info.width}x${info.height} proxy=${pInfo.width}x${pInfo.height} rule(preview=proxy,export=original)=${ruleOk} capacity: originals=${fpsOriginal.toFixed(0)}fps proxies=${fpsProxy.toFixed(0)}fps (2 streams stacked)`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:f6_export_test': {
      // Foundation Phase 6: range export honors in/out marks (duration +
      // audio window), and hevc/gif/m4a produce valid files. Uses the
      // p5_export-style scene (video + tone with fade).
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'f6-export', pass, detail }).catch(() => {})
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await wait(300)
        const st = () => useStore.getState()
        st().pause()
        const { uid: mkid } = await import('../types/project')
        const { convertFileSrc } = await import('@tauri-apps/api/core')
        const tonePath = await invoke<string>('spike_audio', { pattern: null })
        st().addMedia({
          id: mkid('m'),
          path: tonePath,
          playbackUrl: convertFileSrc(tonePath),
          name: 'tone.wav',
          kind: 'audio',
          duration: 10,
          hasAudio: true,
        })
        const tone = st().project.media.find((m) => m.name === 'tone.wav')!
        st().insertClipAt(tone.id, null, 0)
        // Range 2s..5s via real marks.
        st().setMarkIn(2)
        st().setMarkOut(5)
        const { runExport } = await import('../compositor/exportRunner')
        const doneOnce = () =>
          new Promise<boolean>((resolve) => {
            void import('@tauri-apps/api/event').then(({ listen }) => {
              void listen<{ ok: boolean }>('export:done', (e) => resolve(e.payload.ok)).then(
                (un) => setTimeout(un, 120000),
              )
            })
          })
        // 1) mp4 range export
        st().setExportSettings({ format: 'mp4', height: 720, fps: 30, quality: 70 })
        let p = doneOnce()
        await runExport('/tmp/f6-range.mp4')
        const ok1 = await p
        const probe1 = await invoke<{ duration: number; hasAudio: boolean }>('probe_media', {
          path: '/tmp/f6-range.mp4',
        })
        // 2) hevc
        st().setExportSettings({ format: 'hevc' })
        p = doneOnce()
        await runExport('/tmp/f6-range-hevc.mp4')
        const ok2 = await p
        // 3) gif (silent, 15fps)
        st().setExportSettings({ format: 'gif' })
        p = doneOnce()
        await runExport('/tmp/f6-range.gif')
        const ok3 = await p
        // 4) m4a audio-only
        st().setExportSettings({ format: 'm4a' })
        p = doneOnce()
        await runExport('/tmp/f6-range.m4a')
        const ok4 = await p
        const probe4 = await invoke<{ duration: number; width: number }>('probe_media', {
          path: '/tmp/f6-range.m4a',
        })
        st().setMarkIn(null)
        st().setMarkOut(null)
        st().setExportSettings({ format: 'mp4' })
        const durOk = Math.abs(probe1.duration - 3) < 0.15
        const m4aOk = ok4 && probe4.width === 0 && Math.abs(probe4.duration - 3) < 0.25
        void report(
          ok1 && ok2 && ok3 && durOk && m4aOk,
          `mp4=${ok1} dur=${probe1.duration.toFixed(2)}s (want 3) audio=${probe1.hasAudio} hevc=${ok2} gif=${ok3} m4a=${m4aOk} (${probe4.duration.toFixed(2)}s)`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:p1_mixer_test': {
      // Pro-editor Phase 1: track bus gain is audible (attenuate AND boost —
      // element.volume clamps at 1, the bus GainNode must not), per-track
      // meters read signal, the mixer UI drives real gain, solid clip lands.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p1-mixer', pass, detail }).catch(() => {})
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await wait(300)
        const st = () => useStore.getState()
        const { readPeaks, readTrackPeak } = await import('../engine/audioGraph')
        const { uid: mkid } = await import('../types/project')
        const { convertFileSrc } = await import('@tauri-apps/api/core')
        const tonePath = await invoke<string>('spike_audio', { pattern: null })
        st().addMedia({
          id: mkid('m'),
          path: tonePath,
          playbackUrl: convertFileSrc(tonePath),
          name: 'tone.wav',
          kind: 'audio',
          duration: 10,
          hasAudio: true,
        })
        const tone = st().project.media.find((m) => m.name === 'tone.wav')!
        st().insertClipAt(tone.id, null, 0)
        const audioTrack = st().project.tracks.find((t) =>
          t.clips.some((c) => c.mediaId === tone.id),
        )!
        st().setPlayhead(1)
        st().play()
        // Baseline: poll until the tone reaches both meters.
        let base = 0
        for (let i = 0; i < 40 && base < 0.05; i++) {
          await wait(150)
          base = readPeaks().l
        }
        let trackPeak = 0
        for (let i = 0; i < 20 && trackPeak < 0.05; i++) {
          await wait(100)
          trackPeak = readTrackPeak(audioTrack.id)
        }
        // Attenuate via the bus.
        st().setTrackGain(audioTrack.id, 0.2)
        let quiet = readPeaks().l
        for (let i = 0; i < 30 && !(quiet > 0.001 && quiet < base * 0.45); i++) {
          await wait(200)
          quiet = readPeaks().l
        }
        // Boost past unity — the whole reason the bus GainNode exists.
        st().setTrackGain(audioTrack.id, 1.5)
        let loud = 0
        for (let i = 0; i < 30 && loud < base * 1.2; i++) {
          await wait(200)
          loud = readPeaks().l
        }
        st().setTrackGain(audioTrack.id, 1)
        st().pause()
        // Mixer UI drives the store through a real input event.
        st().setMixerOpen(true)
        await wait(250)
        const tracksAtOpen = st().project.tracks.length
        const strips = document.querySelectorAll('.mixer__strip').length
        const fader = document.querySelector<HTMLInputElement>('.mixer__fader')
        let uiOk = false
        if (fader) {
          const setter = Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )!.set!
          setter.call(fader, '0.5')
          fader.dispatchEvent(new Event('input', { bubbles: true }))
          await wait(150)
          uiOk = Math.abs((st().project.tracks[0].gain ?? 1) - 0.5) < 0.01
        }
        st().setMixerOpen(false)
        // Export parity: the fader must survive into the FILE. Two fast
        // audio-only exports; volumedetect max should drop ~14dB at g=0.2.
        st().setMarkIn(1)
        st().setMarkOut(3)
        st().setExportSettings({ format: 'm4a' })
        const { runExport } = await import('../compositor/exportRunner')
        const once = () =>
          new Promise<boolean>((resolve) => {
            void import('@tauri-apps/api/event').then(({ listen }) => {
              void listen<{ ok: boolean }>('export:done', (e) => resolve(e.payload.ok)).then(
                (un) => setTimeout(un, 60000),
              )
            })
          })
        st().setTrackGain(audioTrack.id, 1)
        let d = once()
        await runExport('/tmp/p1-unity.m4a')
        await d
        st().setTrackGain(audioTrack.id, 0.2)
        d = once()
        await runExport('/tmp/p1-fifth.m4a')
        await d
        st().setTrackGain(audioTrack.id, 1)
        const a1 = await invoke<{ maxDb: number | null }>('analyze_audio', {
          path: '/tmp/p1-unity.m4a',
        })
        const a2 = await invoke<{ maxDb: number | null }>('analyze_audio', {
          path: '/tmp/p1-fifth.m4a',
        })
        const drop = (a1.maxDb ?? 0) - (a2.maxDb ?? 0)
        const exportGainOk = drop > 10 && drop < 18 // 20·log10(5) ≈ 14dB
        // Solid clip.
        st().addSolidClip('#102030')
        const solid = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.shape?.fill === '#102030')
        const solidOk =
          !!solid && solid.shape!.width === st().project.canvas.width && solid.volume === 0
        const pass =
          base > 0.05 && trackPeak > 0.05 && quiet < base * 0.45 && loud > base * 1.2 &&
          strips === tracksAtOpen + 1 && uiOk && solidOk && exportGainOk
        void report(
          pass,
          `base=${base.toFixed(2)} trackPeak=${trackPeak.toFixed(2)} quiet=${quiet.toFixed(2)} loud=${loud.toFixed(2)} strips=${strips} uiOk=${uiOk} solidOk=${solidOk} exportDropDb=${drop.toFixed(1)}`,
        )
      } catch (e) {
        void report(false, `threw: ${e}`)
      }
      break
    }
    case 'dev:small_window': {
      const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window')
      await getCurrentWindow().setSize(new LogicalSize(980, 660))
      break
    }
    case 'dev:normal_window': {
      const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window')
      await getCurrentWindow().setSize(new LogicalSize(1280, 800))
      break
    }
    case 'dev:p1_show': {
      // Evidence scene for Phase 1 captures: tone waveform on the timeline,
      // solid matte under the playhead, mixer open, playing for live meters.
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      await loadPipDemo()
      await wait(300)
      const st = () => useStore.getState()
      const { uid: mkid } = await import('../types/project')
      const { convertFileSrc } = await import('@tauri-apps/api/core')
      const tonePath = await invoke<string>('spike_audio', { pattern: null })
      st().addMedia({
        id: mkid('m'),
        path: tonePath,
        playbackUrl: convertFileSrc(tonePath),
        name: 'tone.wav',
        kind: 'audio',
        duration: 10,
        hasAudio: true,
      })
      const tone = st().project.media.find((m) => m.name === 'tone.wav')!
      st().insertClipAt(tone.id, null, 0)
      st().setPlayhead(6)
      st().addSolidClip('#0f2233')
      st().setMixerOpen(true)
      st().setTimelineHeight(320) // audio lane + waveform in frame
      st().setPlayhead(1)
      st().play()
      await wait(1500)
      break
    }
    case 'dev:p2_fx_test': {
      // Pro-editor Phase 2: the stack drives the REAL app — store ops, panel
      // cards, reorder, duplicate-same-type, keyframed instance param.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p2-fx', pass, detail }).catch(() => {})
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await wait(300)
        const st = () => useStore.getState()
        st().pause()
        const cam = st()
          .project.tracks.filter((t) => t.kind === 'video')
          .sort((a, b) => b.z - a.z)[0].clips[0]
        st().addEffect(cam.id, 'grade')
        st().addEffect(cam.id, 'blur')
        st().addEffect(cam.id, 'grade') // same type twice
        const fx = () =>
          st()
            .project.tracks.flatMap((t) => t.clips)
            .find((c) => c.id === cam.id)!.effects
        const sameTypeTwice = fx().filter((e) => e.type === 'grade').length === 2
        st().updateEffectParams(cam.id, fx()[0].id, { exposure: 1.2 })
        st().moveEffect(cam.id, fx()[2].id, -1) // second grade above blur
        const orderAfter = fx().map((e) => e.type).join(',')
        // Keyframe an instance param through the stopwatch path.
        st().setPlayhead(1)
        st().toggleKeyframe(cam.id, `fx.${fx()[1].id}.exposure`)
        const kfOk = st()
          .project.tracks.flatMap((t) => t.clips)
          .find((c) => c.id === cam.id)!
          .keyframes.some((k) => k.prop === `fx.${fx()[1].id}.exposure`)
        // Panel renders one card per instance.
        st().select([cam.id])
        await wait(300)
        const cards = document.querySelectorAll('.fxcard').length
        // Leave the Effects section in view for the evidence capture.
        document.querySelector('.fxcard')?.scrollIntoView({ block: 'center' })
        // Compositor still live with the chain running.
        const live = st().compositorActive
        const pass =
          sameTypeTwice && orderAfter === 'grade,grade,blur' && kfOk && cards === 3 && live
        void report(
          pass,
          `sameTypeTwice=${sameTypeTwice} order=${orderAfter} kfOk=${kfOk} cards=${cards} compositor=${live}`,
        )
      } catch (e) {
        void report(false, `threw: ${e}`)
      }
      break
    }
    case 'dev:p2_migration_test': {
      // THE migration demand from the plan: a REAL pre-change project file
      // (fixed-property effects + old keyframe props), saved to disk as a
      // genuine bundle, opened through the REAL load path — must arrive as a
      // canonical-order stack with rewritten keyframes and no legacy fields.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'p2-migration', pass, detail }).catch(() => {})
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo() // brings real media paths into scope
        await wait(200)
        const st = () => useStore.getState()
        const mediaPath = st().project.media[0].path
        const legacy = {
          version: 1,
          canvas: { width: 1920, height: 1080, fps: 30, background: '#000000' },
          duration: 10,
          media: [
            {
              id: 'm1',
              path: mediaPath,
              name: 'legacy.mp4',
              kind: 'video',
              duration: 10,
              hasAudio: false,
            },
          ],
          tracks: [
            {
              id: 't1',
              kind: 'video',
              z: 0,
              name: 'V1',
              clips: [
                {
                  id: 'c1',
                  kind: 'video',
                  mediaId: 'm1',
                  start: 0,
                  in: 0,
                  out: 5,
                  speed: 1,
                  volume: 1,
                  transform: {
                    x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, cornerRadius: 0,
                    crop: { l: 0, t: 0, r: 0, b: 0 }, shadow: null,
                  },
                  keyframes: [
                    { prop: 'grade.exposure', t: 0, v: 0, ease: 'linear' },
                    { prop: 'grade.exposure', t: 2, v: 1, ease: 'linear' },
                    { prop: 'blur', t: 0, v: 4, ease: 'linear' },
                    { prop: 'transform.x', t: 0, v: 9, ease: 'linear' },
                  ],
                  transitions: { in: null, out: null },
                  effects: [],
                  // The pre-stack fixed slots:
                  key: { color: '#00ff00', tolerance: 0.2, softness: 0.1, spill: 0.5 },
                  grade: { exposure: 0.3, contrast: 0, saturation: -0.5, temperature: 0, tint: 0 },
                  mask: { kind: 'ellipse', x: 1, y: 2, w: 300, h: 200, feather: 15, invert: true },
                  blur: 4,
                  vignette: 0.7,
                  blend: 'screen',
                },
              ],
            },
          ],
          transcript: { words: [] },
        }
        const bundle = '/tmp/p2-legacy.motionaire'
        await invoke('save_project', {
          bundlePath: bundle,
          projectJson: JSON.stringify(legacy, null, 2),
          name: 'p2-legacy',
          thumbJpegBase64: null,
        })
        const { openProjectPath } = await import('../persistence/projectIO')
        await openProjectPath(bundle)
        await wait(300)
        const clip = st().project.tracks[0].clips[0]
        const types = clip.effects.map((e) => e.type).join(',')
        const canonical = types === 'chromaKey,blur,grade,mask,vignette'
        const legacyGone = !('key' in clip) && !('grade' in clip) && !('mask' in clip)
        const paramsOk =
          clip.effects[0].params.tolerance === 0.2 &&
          clip.effects[2].params.saturation === -0.5 &&
          clip.effects[3].params.invert === true &&
          clip.effects[4].params.amount === 0.7
        const blendKept = clip.blend === 'screen'
        const gradeId = clip.effects[2].id
        const blurId = clip.effects[1].id
        const props = clip.keyframes.map((k) => k.prop)
        const kfsRewritten =
          props.includes(`fx.${gradeId}.exposure`) &&
          props.includes(`fx.${blurId}.amount`) &&
          props.includes('transform.x') &&
          !props.some((p) => p.startsWith('grade.') || p === 'blur')
        const live = st().compositorActive
        const pass = canonical && legacyGone && paramsOk && blendKept && kfsRewritten && live
        void report(
          pass,
          `types=${types} legacyGone=${legacyGone} paramsOk=${paramsOk} blendKept=${blendKept} kfs=${kfsRewritten} compositor=${live}`,
        )
      } catch (e) {
        void report(false, `threw: ${e}`)
      }
      break
    }
    case 'dev:vr_scene': {
      // Visual-regression scene (Phase 0): fixed window size, deterministic
      // fixture content, fixed playhead, no transient chrome. Reports
      // vr-scene PASS when settled so scripts/visual.sh knows when to shoot.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'vr-scene', pass, detail }).catch(() => {})
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const until = async (cond: () => boolean, ms: number) => {
        const t0 = Date.now()
        while (!cond() && Date.now() - t0 < ms) await wait(100)
        return cond()
      }
      try {
        const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window')
        await getCurrentWindow().setSize(new LogicalSize(1280, 800))
        const st = () => useStore.getState()
        await loadPipDemo()
        st().pause()
        st().setDialog(null)
        st().select([])
        st().setPlayhead(1)
        st().addTextClip('Visual baseline')
        st().setPlayhead(1.5)
        st().select([])
        const live = await until(() => st().compositorActive, 8000)
        // Transient chrome is nondeterministic — clear it.
        for (const t of [...st().toasts]) st().dismissToast(t.id)
        await until(() => st().toasts.length === 0, 3000)
        await wait(1200) // text raster + filmstrip settle
        void report(live, `compositor=${live}`)
      } catch (e) {
        void report(false, `threw: ${e}`)
      }
      break
    }
    case 'dev:vr_sheet': {
      useStore.getState().setDialog('shortcuts')
      await new Promise((r) => setTimeout(r, 300))
      void invoke('report_test', { name: 'vr-sheet', pass: true, detail: 'open' }).catch(() => {})
      break
    }
    case 'dev:smoke': {
      // THE critical path as one test (pro-editor session, Phase 0): new
      // project -> import media -> place clips -> play (real compositor
      // frames) -> apply an effect -> add text -> export -> ffprobe verify.
      // If this passes, the app fundamentally works.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'smoke', pass, detail }).catch(() => {})
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const until = async (cond: () => boolean, ms: number) => {
        const t0 = Date.now()
        while (!cond() && Date.now() - t0 < ms) await wait(100)
        return cond()
      }
      try {
        const st = () => useStore.getState()
        // 1. new project + import + place (loadPipDemo = real native import
        //    of two generated fixtures + placement on two tracks)
        await loadPipDemo()
        await wait(300)
        const placed = st().project.tracks.reduce((n, t) => n + t.clips.length, 0)
        // 2. play: the compositor must produce real frames and the clock must
        //    advance. Poll — never sleep-and-hope (house rule).
        st().setPlayhead(0.5)
        st().play()
        const advanced = await until(() => st().playhead > 1.0, 8000)
        const fpsLive = await until(
          () => st().compositorActive && st().compositorFps > 5,
          4000,
        )
        st().pause()
        // 3. apply an effect + add text
        const vid = st()
          .project.tracks.filter((t) => t.kind === 'video')
          .flatMap((t) => t.clips)
          .find((c) => c.kind === 'video')!
        st().setClipBlend(vid.id, 'multiply')
        st().setClipProperty(vid.id, `${ensureFx(vid.id, 'vignette')}amount`, 0.4)
        st().setPlayhead(1)
        st().addTextClip('Smoke test')
        const hasText = st()
          .project.tracks.flatMap((t) => t.clips)
          .some((c) => c.kind === 'text')
        // 4. export 2s and verify the file with ffprobe
        st().setMarkIn(0.5)
        st().setMarkOut(2.5)
        st().setExportSettings({ format: 'mp4', height: 720, fps: 30, quality: 70 })
        const done = new Promise<boolean>((resolve) => {
          void import('@tauri-apps/api/event').then(({ listen }) => {
            void listen<{ ok: boolean }>('export:done', (e) => resolve(e.payload.ok)).then(
              (un) => setTimeout(un, 120000),
            )
          })
        })
        const { runExport } = await import('../compositor/exportRunner')
        await runExport('/tmp/smoke.mp4')
        const exportOk = await done
        const probe = await invoke<{ duration: number; hasAudio: boolean }>('probe_media', {
          path: '/tmp/smoke.mp4',
        })
        const durOk = Math.abs(probe.duration - 2.0) < 0.2
        const pass =
          placed >= 2 && advanced && fpsLive && hasText && exportOk && durOk
        void report(
          pass,
          `placed=${placed} advanced=${advanced} fpsLive=${fpsLive} hasText=${hasText} exportOk=${exportOk} exportDur=${probe.duration.toFixed(2)}`,
        )
      } catch (e) {
        void report(false, `threw: ${e}`)
      }
      break
    }
    case 'dev:f8_demo': {
      // Visual evidence scene: all three title templates over the pip demo,
      // centered title dogfooding the Phase 8 gradient + shadow.
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      await loadPipDemo()
      await wait(300)
      const st = () => useStore.getState()
      st().pause()
      st().setPlayhead(1)
      st().addTitleTemplate('lowerThird')
      st().addTitleTemplate('caption')
      st().setPlayhead(2)
      st().addTitleTemplate('centered')
      const cen = st()
        .project.tracks.flatMap((t) => t.clips)
        .find((c) => c.text?.content === 'Title')
      if (cen)
        st().updateTextClip(cen.id, {
          style: { gradient: { from: '#ffd75e', to: '#ff5e8a' } },
        })
      st().setPlayhead(2.2)
      break
    }
    case 'dev:f8_recovery': {
      // Simulate a crash-orphaned untitled project so the launcher banner can
      // be captured after a reload.
      await invoke('save_untitled_recovery', {
        projectJson: JSON.stringify(createProject()),
      })
      break
    }
    case 'dev:f8_restore_click': {
      // Real click on the launcher banner's Restore: must land in the editor,
      // dirty, still path-less (so autosave + close guard keep protecting it).
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'f8-restore', pass, detail }).catch(() => {})
      const btn = document.querySelector<HTMLButtonElement>(
        '.launcher__recovery .shell__primary',
      )
      if (!btn) {
        void report(false, 'no banner button in DOM')
        break
      }
      btn.click()
      await new Promise((r) => setTimeout(r, 300))
      const s2 = useStore.getState()
      void report(
        s2.appView === 'editor' && s2.dirty && !s2.projectPath,
        `view=${s2.appView} dirty=${s2.dirty} path=${String(s2.projectPath)}`,
      )
      break
    }
    case 'dev:f8_recovery_clear': {
      await invoke('clear_untitled_recovery')
      break
    }
    case 'dev:f8_test': {
      // Foundation Phase 8: vertical group move (atomic, all-or-nothing),
      // untitled-recovery round-trip, title templates, text-polish raster.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'f8-cleanup', pass, detail }).catch(() => {})
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await wait(300)
        const st = () => useStore.getState()
        st().pause()
        const p = () => st().project
        const topVid = () =>
          p().tracks.filter((t) => t.kind === 'video').sort((a, b) => b.z - a.z)[0]

        // -- vertical group move --
        st().setPlayhead(20)
        st().addTextClip('one')
        st().setPlayhead(24)
        st().addTextClip('two')
        const srcTrack = topVid()
        const [t1, t2] = srcTrack.clips.filter((c) => c.kind === 'text').map((c) => c.id)
        st().addTrack('video')
        const dstTrack = topVid() // new track lands on top
        st().moveClipsTo([
          { id: t1, start: 20, trackId: dstTrack.id },
          { id: t2, start: 24, trackId: dstTrack.id },
        ])
        const onDst = p().tracks.find((t) => t.id === dstTrack.id)!.clips.map((c) => c.id)
        const movedBoth = onDst.includes(t1) && onDst.includes(t2)
        // collision on target must reject the WHOLE move. setPlayhead clamps
        // to project duration, so locate the blocker where it actually landed
        // instead of assuming.
        st().setPlayhead(40)
        st().addTextClip('blocker')
        const blocker = p()
          .tracks.flatMap((t) => t.clips)
          .find((c) => c.text?.content === 'blocker')!
        const bTrackId = p().tracks.find((t) => t.clips.some((c) => c.id === blocker.id))!.id
        st().moveClipsTo([
          { id: t1, start: blocker.start + 1, trackId: bTrackId }, // overlaps blocker
          { id: t2, start: blocker.start + 100, trackId: bTrackId },
        ])
        const afterReject = p().tracks.find((t) => t.id === dstTrack.id)!.clips
        const rejected =
          afterReject.find((c) => c.id === t1)?.start === 20 &&
          afterReject.find((c) => c.id === t2)?.start === 24
        // kind mismatch must reject too
        const audioTrack = p().tracks.find((t) => t.kind === 'audio')
        let kindOk = true
        if (audioTrack) {
          st().moveClipsTo([{ id: t1, start: 60, trackId: audioTrack.id }])
          kindOk = p().tracks.find((t) => t.id === dstTrack.id)!.clips.some((c) => c.id === t1)
        }

        // -- untitled recovery round-trip --
        const json = JSON.stringify({ probe: 'f8' })
        await invoke('save_untitled_recovery', { projectJson: JSON.stringify(p()) })
        const got = await invoke<string | null>('check_untitled_recovery')
        const recSaved = !!got && got.includes('"tracks"')
        await invoke('clear_untitled_recovery')
        const recCleared = (await invoke<string | null>('check_untitled_recovery')) === null
        void json

        // -- title templates -- (identify pieces by their fixed content, not
        // by assumed start times: the playhead clamps to duration)
        const count = () => p().tracks.reduce((n, t) => n + t.clips.length, 0)
        st().setPlayhead(p().duration)
        const before = count()
        st().addTitleTemplate('lowerThird')
        const ltText = p()
          .tracks.flatMap((t) => t.clips.map((c) => ({ c, tid: t.id })))
          .find(({ c }) => c.text?.content.startsWith('Name'))
        const ltBar = p()
          .tracks.flatMap((t) => t.clips.map((c) => ({ c, tid: t.id })))
          .find(({ c }) => c.shape?.kind === 'rect' && c.shape.fill === '#1f6feb')
        const lowerThird =
          count() === before + 2 &&
          !!ltText &&
          !!ltBar &&
          ltText.tid !== ltBar.tid &&
          ltText.c.start === ltBar.c.start
        st().setPlayhead(p().duration)
        st().addTitleTemplate('centered')
        const cen = p()
          .tracks.flatMap((t) => t.clips)
          .find((c) => c.text?.content === 'Title')
        const centered = !!cen?.text?.shadow && (cen.text.letterSpacing ?? 0) > 0
        st().setPlayhead(p().duration)
        st().addTitleTemplate('caption')
        const cap = p()
          .tracks.flatMap((t) => t.clips)
          .find((c) => c.text?.content === 'Caption text')
        const caption = !!cap?.text?.background

        // -- text polish raster: shadow pads the canvas, spacing widens it --
        const { rasterizeText } = await import('../compositor/textRaster')
        const base = {
          content: 'Polish',
          font: 'Inter',
          size: 64,
          weight: 700,
          color: '#ffffff',
          align: 'center' as const,
          stroke: null,
          background: null,
          maxWidth: 1200,
        }
        const plain = rasterizeText(base)!
        const shadowed = rasterizeText({
          ...base,
          shadow: { color: '#000000', blur: 10, x: 0, y: 4 },
        })!
        const spaced = rasterizeText({ ...base, letterSpacing: 10 })!
        const grad = rasterizeText({ ...base, gradient: { from: '#ff0000', to: '#0000ff' } })
        const rasterOk =
          shadowed.w > plain.w && shadowed.h > plain.h && spaced.w > plain.w && !!grad

        const pass =
          movedBoth && rejected && kindOk && recSaved && recCleared &&
          lowerThird && centered && caption && rasterOk
        void report(
          pass,
          `movedBoth=${movedBoth} rejected=${rejected} kindOk=${kindOk} recSaved=${recSaved} recCleared=${recCleared} lowerThird=${lowerThird} centered=${centered} caption=${caption} rasterOk=${rasterOk}`,
        )
      } catch (e) {
        void report(false, `threw: ${e}`)
      }
      break
    }
    case 'dev:f7_test': {
      // Foundation Phase 7: consolidate copies + rewrites + saves; prefs
      // persist through SQLite; shortcut sheet opens via real ⌘/ keydown.
      const report = (pass: boolean, detail: string) =>
        invoke('report_test', { name: 'f7-workflow', pass, detail }).catch(() => {})
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      try {
        await loadPipDemo()
        await wait(300)
        const st = () => useStore.getState()
        st().pause()
        const spike = st().project.media[0].path
        const dir = spike.slice(0, spike.lastIndexOf('/'))
        const bundle = `${dir}/f7-e2e.motionaire`
        st().setProjectPath(bundle)
        const { saveProject, consolidateMedia } = await import('../persistence/projectIO')
        await saveProject()
        const movedCount = await consolidateMedia()
        const allInside = st().project.media.every((m) => m.path.startsWith(bundle))
        const probed = await invoke<{ duration: number }>('probe_media', {
          path: st().project.media[0].path,
        })
        const filesReal = probed.duration > 1
        const cleanAfter = !st().dirty // consolidate ends with a save
        // prefs round-trip
        st().setPrefs({ autosaveSecs: 60 })
        await invoke('set_setting', {
          key: 'prefs',
          value: JSON.stringify(st().prefs),
        })
        const raw = await invoke<string | null>('get_setting', { key: 'prefs' })
        const prefsOk = !!raw && (JSON.parse(raw) as { autosaveSecs: number }).autosaveSecs === 60
        st().setPrefs({ autosaveSecs: 30 })
        await invoke('set_setting', { key: 'prefs', value: JSON.stringify(st().prefs) })
        // ⌘/ opens the sheet
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true }),
        )
        await wait(200)
        const sheetOpen = !!document.querySelector('.shortcuts')
        void report(
          movedCount === 2 && allInside && filesReal && cleanAfter && prefsOk && sheetOpen,
          `moved=${movedCount} allInside=${allInside} filesReal=${filesReal} clean=${cleanAfter} prefs=${prefsOk} sheet=${sheetOpen}`,
        )
      } catch (e) {
        void report(false, String(e))
      }
      break
    }
    case 'dev:transition_demo': {
      // Two adjacent clips on ONE track with a dissolve on the cut — the
      // compositor-transition verification scene.
      await loadPipDemo()
      const st = useStore.getState()
      const tracks = st.project.tracks.filter((t) => t.kind === 'video').sort((a, b) => a.z - b.z)
      const [v1, v2] = tracks
      const a = v1?.clips[0]
      const b = v2?.clips[0]
      if (!a || !b) break
      st.trimClip(a.id, 'out', 5)
      st.moveClip(b.id, 5, v1!.id)
      const moved = useStore
        .getState()
        .project.tracks.flatMap((t) => t.clips)
        .find((c) => c.id === b.id)
      if (moved) {
        useStore.getState().trimClip(b.id, 'out', 10)
        useStore.getState().setClipProperty(b.id, 'transform.scale', 1) // clear PiP keyframes? kfs remain; scale kf overrides — clear all:
      }
      // Strip the PiP keyframes so the incoming clip is fullscreen.
      for (const prop of [
        'transform.scale',
        'transform.x',
        'transform.y',
        'transform.cornerRadius',
      ])
        useStore.getState().clearKeyframes(b.id, prop)
      useStore.getState().setTransition(b.id, 'in', { type: 'dissolve', duration: 1.2 })
      useStore.getState().setPlayhead(4.5)
      break
    }
  }
  if (action.startsWith('dev:view:')) {
    const v = action.slice('dev:view:'.length)
    if (['activate', 'onboard', 'launcher', 'editor'].includes(v))
      s.setAppView(v as 'activate' | 'onboard' | 'launcher' | 'editor')
  }
  if (action.startsWith('dev:seek:')) {
    const t = Number(action.slice('dev:seek:'.length))
    if (Number.isFinite(t)) s.setPlayhead(t)
  }
  if (action.startsWith('dev:scrubstorm')) {
    const secs = Number(action.split(':')[2] ?? 8)
    await runScrubStorm(Number.isFinite(secs) && secs > 0 ? secs : 8)
  }
}

// Phase-1 forensics: hammer the playhead like an aggressive scrub drag while
// capturing (a) the native webview pixels and (b) the canvas's OWN pixel data
// at the same instants. If (b) is valid while (a) shows garbage, the defect is
// WebKit displaying a surface that isn't our canvas content; if (b) is also
// garbage, our pipeline delivered bad pixels.
async function runScrubStorm(secs = 8) {
  const report = (pass: boolean, detail: string) =>
    invoke('report_test', { name: 'scrub-storm', pass, detail }).catch(() => {})
  try {
    const s = useStore.getState()
    const dur = Math.max(1, s.project.duration - 0.2)
    s.pause()
    const canvas = document.querySelector('.preview__composite') as HTMLCanvasElement | null
    if (!canvas) {
      void report(false, 'no composite canvas')
      return
    }
    const ctx = canvas.getContext('2d')!
    const samples: string[] = []
    const sampleCanvas = (label: string) => {
      // 5 fixed probe points; a valid composited frame is never all-black
      // at all probes (testsrc2 bars) nor uniform garbage.
      const pts = [
        [0.1, 0.1],
        [0.5, 0.2],
        [0.85, 0.5],
        [0.3, 0.8],
        [0.65, 0.65],
      ]
      const px = pts
        .map(([fx, fy]) => {
          const d = ctx.getImageData(
            Math.floor(canvas.width * fx),
            Math.floor(canvas.height * fy),
            1,
            1,
          ).data
          return `${d[0]},${d[1]},${d[2]}`
        })
        .join(' | ')
      samples.push(`${label}: ${px}`)
    }

    const start = performance.now()
    let captures = 0
    const timer = window.setInterval(() => {
      const t = Math.random() * dur
      useStore.getState().setPlayhead(t)
      const elapsed = performance.now() - start
      if (elapsed > (secs * 250) * (captures + 1) && captures < 3) {
        captures++
        sampleCanvas(`t+${(elapsed / 1000).toFixed(1)}s`)
        void invoke('capture_preview', { path: `/tmp/scrub-${captures}.png` }).catch(() => {})
      }
      if (elapsed > secs * 1000) {
        window.clearInterval(timer)
        sampleCanvas('end')
        void report(true, `storm done; canvas probes → ${samples.join(' ;; ')}`)
      }
      // 30Hz seek rate: still ~3x faster than the pipeline can deliver under
      // seek churn (the user hit 11fps), but leaves the main thread enough
      // slack for WKWebView to service a takeSnapshot mid-storm.
    }, 33)
  } catch (e) {
    void report(false, String(e))
  }
}

export function startMenuBridge() {
  if (!isTauri || started) return
  started = true
  void listen<{ action: string; path?: string }>('menu', (e) => {
    void dispatch(e.payload.action, e.payload.path).catch((err) =>
      console.error(`menu action ${e.payload.action} failed:`, err),
    )
  })
  // Keep the View-menu checkmarks honest when the same toggles flip in-app.
  let lastSafe = useStore.getState().safeZones
  let lastSnap = useStore.getState().snap
  let lastFull = useStore.getState().previewFull
  useStore.subscribe((s) => {
    if (s.safeZones !== lastSafe || s.snap !== lastSnap || s.previewFull !== lastFull) {
      lastSafe = s.safeZones
      lastSnap = s.snap
      lastFull = s.previewFull
      void invoke('sync_view_menu', {
        safeZones: s.safeZones,
        snap: s.snap,
        fullPreview: s.previewFull,
      }).catch(() => {})
    }
  })
}
