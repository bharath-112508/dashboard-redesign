import { useState } from 'react'
import { useSendAsync } from '../../api/queries'
import type { Company } from '../../api/types'
import { TODAY } from '../../lib/dates'
import { Dialog, btnSecondary, errorCls } from '../../components/Dialog'

/** Confirms archiving. Nothing is deleted; the company can be restored. */
export function ArchiveDialog({ company, activeCount, onClose, onArchived }: { company: Company; activeCount: number; onClose: () => void; onArchived: () => void }) {
  const send = useSendAsync()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const archive = async () => {
    setBusy(true)
    setError(null)
    try {
      await send({ type: 'company.archive', id: company.id, archived: true, at: TODAY })
      onArchived()
    } catch {
      setBusy(false)
      setError('The company could not be archived. Try again.')
    }
  }

  return (
    <Dialog titleId="archive-title" eyebrow="Archive company" title={`Archive ${company.name}?`} onClose={onClose} width={480}>
      <div className="mt-3 space-y-2 text-[13.5px] leading-[1.55] text-ink-2">
        {activeCount > 0 && <p className="m-0 font-semibold text-amber-ink">{`It still has ${activeCount} active project${activeCount === 1 ? '' : 's'}.`}</p>}
        <p className="m-0">It is hidden from the company list and its projects leave the Projects page. Nothing is deleted, and you can restore it at any time.</p>
      </div>
      <div className="mt-5 flex items-center justify-end gap-2.5">
        <span role="status" className={`mr-auto ${errorCls}`}>
          {error}
        </span>
        <button type="button" onClick={onClose} className={btnSecondary}>
          Cancel
        </button>
        <button type="button" onClick={archive} disabled={busy} className="h-10 cursor-pointer rounded-[10px] bg-red px-5 text-[13.5px] font-bold text-white hover:bg-red-600 disabled:opacity-60">
          Archive company
        </button>
      </div>
    </Dialog>
  )
}
