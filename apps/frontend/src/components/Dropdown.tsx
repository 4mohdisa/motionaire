import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Check } from 'lucide-react'

const DropdownCtx = createContext<() => void>(() => {})

// Toolbar dropdown primitive (session 8, Phase 2 density pass): one trigger
// button, an anchored panel, outside-click/Escape dismissal. Premiere-style
// consolidation — high-frequency actions stay as bare icons, everything else
// groups in here.

interface DropdownProps {
  icon: LucideIcon
  label: string
  value?: string // optional readout rendered beside the icon (e.g. "100%")
  children: React.ReactNode
  alignRight?: boolean
}

export function Dropdown({ icon: Icon, label, value, children, alignRight }: DropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onEsc)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onEsc)
    }
  }, [open])

  return (
    <div className="dropdown" ref={ref}>
      <button
        className={`iconbtn${open ? ' iconbtn--on' : ''}${value ? ' iconbtn--wide' : ''}`}
        aria-label={label}
        data-tip={open ? undefined : label}
        onClick={() => setOpen(!open)}
      >
        <Icon size={16} strokeWidth={1.75} />
        {value && <span className="dropdown__value">{value}</span>}
      </button>
      {open && (
        <div className={`dropdown__panel${alignRight ? ' dropdown__panel--right' : ''}`}>
          <DropdownCtx.Provider value={() => setOpen(false)}>{children}</DropdownCtx.Provider>
        </div>
      )}
    </div>
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
