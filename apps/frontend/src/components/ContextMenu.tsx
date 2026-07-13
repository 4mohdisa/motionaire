import { Popover } from './Popover'

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

// Context menu = the Popover primitive anchored at the cursor. Collision
// handling (flip/shift/scroll) comes from Popover — no local clamping math.
function ContextMenu({ x, y, items, onClose }: Props) {
  return (
    <Popover point={{ x, y }} onClose={onClose}>
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
    </Popover>
  )
}

export default ContextMenu
