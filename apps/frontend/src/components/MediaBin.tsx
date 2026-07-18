import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open, message } from '@tauri-apps/plugin-dialog'
import { convertFileSrc } from '@tauri-apps/api/core'
import { Film, FolderInput, Music, PanelLeftClose } from 'lucide-react'
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
  // Stills need no async work — their file IS the thumbnail.
  const still = asset.kind === 'video' && /\.(png|jpe?g)$/i.test(asset.path)
  const [strip, setStrip] = useState<{ url: string; w: number; h: number } | null>(null)
  useEffect(() => {
    let gone = false
    if (asset.kind === 'video' && !asset.missing && !still) {
      void getFilmstrip(asset).then((s) => {
        if (s && !gone) setStrip({ url: s.url, w: s.frameW, h: s.h })
      })
    }
    return () => {
      gone = true
    }
  }, [asset, still])

  if (asset.kind === 'audio') return <Music size={16} />
  if (still) return <img className="bin__strip" src={convertFileSrc(asset.path)} alt="" />
  if (!strip) return <Film size={16} />
  return (
    <div
      className="bin__strip"
      style={{
        backgroundImage: `url(${strip.url})`,
        backgroundSize: 'auto 100%',
        backgroundPosition: '0 0',
      }}
    />
  )
}

function MediaBin() {
  const media = useStore((s) => s.project.media)
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState<string | null>(null)
  const folders = [...new Set(media.map((x) => x.folder).filter(Boolean))] as string[]
  const shown = media.filter(
    (x) =>
      (folder === null || x.folder === folder) &&
      (!query || x.name.toLowerCase().includes(query.toLowerCase())),
  )
  // The rail (Run 1, Phase 1f) owns visibility now — when mounted, the bin
  // is open; the header collapse just clears the left panel.
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null)

  const items = (id: string): MenuItem[] => {
    const asset = useStore.getState().project.media.find((m) => m.id === id)
    if (!asset) return []
    return [
      {
        label: 'Open in source monitor',
        onClick: () => useStore.getState().openSource(id),
      },
      {
        label: 'Move to folder…',
        onClick: () => {
          const f = window.prompt('Folder name (empty = root):', asset.folder ?? '')
          if (f !== null) useStore.getState().setMediaFolder(id, f.trim() || null)
        },
      },
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
            label="Hide panel"
            onClick={() => useStore.getState().setLeftPanel(null)}
          />
        </div>
      </div>
      {/* Folders + search (Phase 8). Folders come from asset.folder values;
          right-click an asset to move it. */}
      <div className="bin__filters">
        <input
          className="bin__search selectable"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {folders.length > 0 && (
          <div className="bin__folders">
            <button
              className={`chip${folder === null ? ' chip--on' : ''}`}
              onClick={() => setFolder(null)}
            >
              All
            </button>
            {folders.map((f) => (
              <button
                key={f}
                className={`chip${folder === f ? ' chip--on' : ''}`}
                onClick={() => setFolder(f)}
              >
                {f}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="bin__list">
        {media.length === 0 && (
          <div className="bin__empty">
            No media yet.
            <div className="tl__empty-action">
              <button className="topbar__btn" onClick={() => void importMediaNative()}>
                Import media…
              </button>
            </div>
          </div>
        )}
        {shown.map((m) => (
          <div
            key={m.id}
            className={`bin__item${m.missing ? ' bin__item--missing' : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(MEDIA_DND, m.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onDoubleClick={() => useStore.getState().openSource(m.id)}
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
              <span className="bin__name">
                {m.aiGenerated && <span className="bin__aibadge">AI</span>}
                {m.name}
              </span>
              <span className="bin__info">
                {fmtDur(m.duration)}
                {m.width ? ` · ${m.width}×${m.height}` : ''} · {m.kind}
                {m.proxyPath ? ' · proxy' : ''}
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
