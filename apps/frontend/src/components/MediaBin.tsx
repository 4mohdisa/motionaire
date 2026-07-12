import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, message } from '@tauri-apps/plugin-dialog'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Film, FolderInput, Music, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import { useStore } from '../state/store'
import type { MediaAsset } from '../types/project'
import { getFilmstrip } from '../engine/filmstrip'
import { importMediaNative } from '../persistence/projectIO'
import ContextMenu, { type MenuItem } from './ContextMenu'
import IconBtn from './IconBtn'

// Media bin (session 9, Phase 2) — the project's imported media, draggable
// onto the timeline. Media is project-scoped; the array already persists in
// the bundle.

export const MEDIA_DND = 'text/motionaire-media'

function fmtDur(s: number): string {
  if (!(s > 0)) return '—'
  const m = Math.floor(s / 60)
  return `${m}:${(s - m * 60).toFixed(0).padStart(2, '0')}`
}

function BinThumb({ asset }: { asset: MediaAsset }) {
  const [thumb, setThumb] = useState<{ url: string; w: number; h: number } | null>(null)
  useEffect(() => {
    let gone = false
    if (asset.kind === 'video' && !asset.missing) {
      if (/\.(png|jpe?g)$/i.test(asset.path)) {
        setThumb({ url: convertFileSrc(asset.path), w: 0, h: 0 })
      } else {
        void getFilmstrip(asset).then((s) => {
          if (s && !gone) setThumb({ url: s.url, w: s.frameW, h: s.h })
        })
      }
    }
    return () => {
      gone = true
    }
  }, [asset])

  if (asset.kind === 'audio') return <Music size={16} />
  if (!thumb) return <Film size={16} />
  return thumb.w > 0 ? (
    <div
      className="bin__strip"
      style={{
        backgroundImage: `url(${thumb.url})`,
        backgroundSize: 'auto 100%',
        backgroundPosition: '0 0',
      }}
    />
  ) : (
    <img className="bin__strip" src={thumb.url} alt="" />
  )
}

function MediaBin() {
  const media = useStore((s) => s.project.media)
  const binOpen = useStore((s) => s.binOpen)
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)

  if (!binOpen) {
    return (
      <div className="bin bin--closed">
        <IconBtn
          icon={PanelLeftOpen}
          label="Show media bin"
          onClick={() => useStore.getState().setBinOpen(true)}
        />
      </div>
    )
  }

  const items = (id: string): MenuItem[] => {
    const asset = useStore.getState().project.media.find((m) => m.id === id)
    if (!asset) return []
    return [
      {
        label: 'Add to timeline at playhead',
        onClick: () => {
          const s = useStore.getState()
          s.insertClipAt(id, null, s.playhead)
        },
      },
      {
        label: 'Reveal in Finder',
        onClick: () => void invoke('reveal_in_finder', { path: asset.path }).catch(() => {}),
        disabled: !!asset.missing || !asset.path.startsWith('/'),
      },
      {
        label: 'Relink…',
        onClick: () => void relink(id),
      },
      { label: '', onClick: () => {}, separator: true },
      {
        label: 'Remove from project (and timeline)',
        onClick: () => useStore.getState().removeMedia(id),
        danger: true,
      },
    ]
  }

  const relink = async (id: string) => {
    const picked = await open({
      title: 'Relink media',
      multiple: false,
      filters: [
        {
          name: 'Media',
          extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'png', 'jpg', 'jpeg'],
        },
      ],
    })
    if (typeof picked !== 'string') return
    try {
      const info = await invoke<{
        width: number
        height: number
        fps: number
        duration: number
        hasAudio: boolean
      }>('probe_media', { path: picked })
      useStore.getState().updateMedia(id, {
        path: picked,
        playbackUrl: convertFileSrc(picked),
        missing: false,
        name: picked.split('/').pop() ?? picked,
        duration: info.duration,
        width: info.width || undefined,
        height: info.height || undefined,
        fps: info.fps || undefined,
        hasAudio: info.hasAudio,
      })
    } catch (e) {
      await message(`Couldn't relink:\n${e}`, { title: 'Relink failed', kind: 'error' })
    }
  }

  return (
    <aside className="bin">
      <div className="bin__head">
        <span className="bin__title">Media</span>
        <div className="bin__headbtns">
          <IconBtn icon={FolderInput} label="Import media" onClick={() => void importMediaNative()} />
          <IconBtn
            icon={PanelLeftClose}
            label="Hide media bin"
            onClick={() => useStore.getState().setBinOpen(false)}
          />
        </div>
      </div>
      <div className="bin__list">
        {media.length === 0 && (
          <div className="bin__empty">No media yet. Import a file to get started.</div>
        )}
        {media.map((m) => (
          <div
            key={m.id}
            className={`bin__item${m.missing ? ' bin__item--missing' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(MEDIA_DND, m.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onDoubleClick={() => {
              const s = useStore.getState()
              s.insertClipAt(m.id, null, s.playhead)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, id: m.id })
            }}
            title={m.path}
          >
            <div className="bin__thumb">
              <BinThumb asset={m} />
              {m.missing && <span className="bin__badge">offline</span>}
            </div>
            <div className="bin__meta">
              <span className="bin__name">{m.name}</span>
              <span className="bin__info">
                {fmtDur(m.duration)}
                {m.width ? ` · ${m.width}×${m.height}` : ''} · {m.kind}
              </span>
            </div>
          </div>
        ))}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={items(menu.id)} onClose={() => setMenu(null)} />
      )}
    </aside>
  )
}

export default MediaBin
