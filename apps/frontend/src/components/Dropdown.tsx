import { createContext, useContext, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Check } from 'lucide-react'
import { Popover } from './Popover'

const DropdownCtx = createContext<() => void>(() => {})

// Toolbar dropdown primitive. Since the foundation session the panel renders
// through the Popover portal, so it can never be clipped by toolbar/timeline
// overflow and flips upward near the bottom of the window (the Add-menu bug
// class).

interface DropdownProps {
  icon: LucideIcon
  label: string
  value?: string // optional readout rendered beside the icon (e.g. "100%")
  children: React.ReactNode
  alignRight?: boolean
}

export function Dropdown({ icon: Icon, label, value, children, alignRight }: DropdownProps) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)

  return (
    <>
      <button
        className={`iconbtn${anchor ? ' iconbtn--on' : ''}${value ? ' iconbtn--wide' : ''}`}
        aria-label={label}
        data-tip={anchor ? undefined : label}
        onPointerDown={(e) => {
          // pointerdown (not click): the Popover's outside-pointerdown fires
          // first on re-click, so click-to-toggle would immediately reopen.
          e.stopPropagation()
          setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())
        }}
      >
        <Icon size={16} strokeWidth={1.75} />
        {value && <span className="dropdown__value">{value}</span>}
      </button>
      {anchor && (
        <Popover anchorRect={anchor} alignRight={alignRight} onClose={() => setAnchor(null)}>
          <DropdownCtx.Provider value={() => setAnchor(null)}>{children}</DropdownCtx.Provider>
        </Popover>
      )}
    </>
  )
}

// Check-row for toggle options inside a dropdown panel.
export function DropdownCheck({
  label,
  checked,
  onToggle,
}: {
  label: string
  checked: boolean
  onToggle: () => void
}) {
  return (
    <button className="menu__item dropdown__check" onClick={onToggle}>
      <span className="dropdown__checkmark">{checked ? <Check size={13} /> : null}</span>
      {label}
    </button>
  )
}

// Action row: closes the panel after firing (toggles stay open by design).
export function DropdownItem({
  label,
  onClick,
  disabled,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  const close = useContext(DropdownCtx)
  return (
    <button
      className="menu__item"
      disabled={disabled}
      onClick={() => {
        onClick()
        close()
      }}
    >
      {label}
    </button>
  )
}
