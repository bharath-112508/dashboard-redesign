import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export const HEADER_SLOT_ID = 'app-header-slot'

/** Renders page-specific controls (search, buttons) into the right side of the shared top bar. */
export function HeaderSlot({ children }: { children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useEffect(() => setEl(document.getElementById(HEADER_SLOT_ID)), [])
  return el ? createPortal(children, el) : null
}
