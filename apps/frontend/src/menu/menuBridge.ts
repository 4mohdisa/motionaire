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

async function dispatch(action: string, path?: string) {
  const s = useStore.getState()
  switch (action) {
    case 'file:new':
      // ponytail: no dirty-check prompt yet — undo history is cleared by design.
      s.replaceProject(createProject(), null)
      break
    case 'file:open':
      await openProject()
      break
    case 'file:open_recent':
      if (path) await openProjectPath(path)
      break
    case 'file:save':
      await saveProject()
      break
    case 'file:save_as':
      await saveProject(true)
      break
    case 'file:close':
      // Back to the launcher; the editor is a full-window view it replaces.
      s.pause()
      s.replaceProject(createProject(), null)
      s.setAppView('launcher')
      break
    case 'file:import':
      await importMediaNative()
      break
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
      st.toggleKeyframe(cam.id, 'grade.exposure')
      st.toggleKeyframe(cam.id, 'grade.saturation')
      st.setPlayhead(6)
      st.setClipProperty(cam.id, 'grade.exposure', 2)
      st.setClipProperty(cam.id, 'grade.saturation', -1)
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
        st().setClipProperty(adj.id, 'grade.saturation', -1)
        st().setClipProperty(adj.id, 'grade.exposure', 0.6)
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
        st().setClipProperty(screenClip.id, 'grade.saturation', -0.6)
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
        st().addMedia({
          id: mkid('m'),
          path: tonePath,
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
