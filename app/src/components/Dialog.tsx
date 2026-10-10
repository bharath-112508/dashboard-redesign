import type { ReactNode } from 'react'
import { useEscape } from '../features/useEscape'
import { CloseButton } from './ui'

/**
 * A centred window with a backdrop. Escape and the backdrop close it. Pages put
 * the form inside; the footer buttons are the caller's.
 */
export function Dialog({
  titleId,
  eyebrow,
  title,
  onClose,
  children,
  width = 560,
  z = 70,
}: {
  titleId: string
  eyebrow?: string
  title: ReactNode
  onClose: () => void
  children: ReactNode
  width?: number
  z?: number
}) {
  useEscape(onClose)
  return (
    <>
      <div className="fixed inset-0 animate-fade-in bg-[rgba(27,45,69,0.42)]" style={{ zIndex: z }} onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed left-1/2 top-1/2 max-h-[calc(100vh-40px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[22px] border-[1.5px] border-line bg-white px-[26px] py-6 shadow-[0_30px_90px_rgba(27,45,69,0.3)] animate-pop-in"
        style={{ zIndex: z + 1, width: `min(${width}px, calc(100vw - 32px))` }}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {eyebrow && <div className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-blue-ink">{eyebrow}</div>}
            <h2 id={titleId} className="m-0 mt-0.5 text-[20px] font-extrabold leading-tight text-ink">
              {title}
            </h2>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        {children}
      </div>
    </>
  )
}

/** Shared classes for dialog and page form controls. */
export const fieldCls =
  'h-[38px] w-full rounded-[9px] border-[1.5px] border-line bg-white px-3 text-[13.5px] text-ink outline-0 focus:border-blue'
export const labelCls = 'mb-1.5 block text-[12px] font-bold text-ink-2'
export const btnPrimary =
  'h-10 cursor-pointer rounded-[10px] bg-blue px-5 text-[13.5px] font-bold text-white hover:bg-blue-600 disabled:cursor-default disabled:opacity-60'
export const btnSecondary =
  'h-10 cursor-pointer rounded-[10px] border-[1.5px] border-faint bg-white px-4 text-[13.5px] font-semibold text-ink hover:border-blue'
export const errorCls = 'text-[12.5px] font-semibold text-red'
