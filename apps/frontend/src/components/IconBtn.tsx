import type { LucideIcon } from 'lucide-react'

// The one button primitive for every toolbar: 16px lucide icon, instant CSS
// tooltip carrying the label (reference: Premiere's dense icon-only rows).

interface Props {
  icon: LucideIcon
  label: string
  onClick?: () => void
  disabled?: boolean
  active?: boolean
  primary?: boolean
  tipBelow?: boolean
}

function IconBtn({ icon: Icon, label, onClick, disabled, active, primary, tipBelow }: Props) {
  const cls = [
    'iconbtn',
    active ? 'iconbtn--on' : '',
    primary ? 'iconbtn--primary' : '',
    tipBelow ? 'iconbtn--tipbelow' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button
      className={cls}
      aria-label={label}
      data-tip={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={16} strokeWidth={1.75} />
    </button>
  )
}

export default IconBtn
