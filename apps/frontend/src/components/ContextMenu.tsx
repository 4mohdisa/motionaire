import { useEffect } from 'react'

export interface MenuItem {
  label: string
  onClick: () => void
  disabled?: boolean
  danger?: boolean
  separator?: boolean
}

interface Props {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}

function ContextMenu({ x, y, items, onClose }: Props) {
  useEffect(() => {
    const dismiss = () => onClose()
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', onEsc)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', onEsc)
      window.removeEventListener('blur', dismiss)
    }
  }, [onClose])

  // Keep the menu on-screen.
  const style: React.CSSProperties = {
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - items.length * 28 - 16),
  }

  return (
    <div className="menu" style={style} onPointerDown={(e) => e.stopPropagation()}>
      {items.map((item, i) =>
        item.separator ? (
          <div key={i} className="menu__sep" />
        ) : (
          <button
            key={i}
            className={`menu__item${item.danger ? ' menu__item--danger' : ''}`}
            disabled={item.disabled}
            onClick={() => {
              item.onClick()
              onClose()
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>
  )
}

export default ContextMenu
