import type { DvProject } from '../../api/devops/types'
import { useDv } from './ctx'
import { addH, fmtD, infraText, lad, ladderNames, offs, statusDesc, TODAY, tone } from './model'

const dateInput = 'mt-1.5 w-full rounded-[10px] border-0 bg-canvas px-2.5 py-[7px] text-[13px] text-ink outline-0'

/**
 * Opens for every status change (Details, the status card, dragging on the
 * board) and for "Edit status description". A status change needs a reason
 * when the date rules ask for one. Moving to Client onboarding also asks for
 * the initial due date and the first reminder; once the initial due date is
 * saved it is fixed.
 */
export function StatusChangeModal() {
  const { db, chg: g, setChg, update } = useDv()
  const c = g && db.projects.find(x => x.key === g.key)
  if (!g || !c) return null
  const s = db.settings
  const same = g.to === c.infra
  const ft = tone(c.infra)
  const tt = tone(g.to)
  const def = statusDesc(s, g.to)
  const need = !same && g.to === 'Client onboarding'
  const dueFixed = !!c.initDue && s.rules.lockInitial
  const due = dueFixed ? c.initDue || '' : g.due
  const reasonMissing = !same && s.rules.requireNote && !(g.note || '').trim()
  const blocked = (need && (!due || !g.start)) || reasonMissing
  const set = (patch: Partial<typeof g>) => setChg(x => (x ? { ...x, ...patch } : x))
  const cancel = () => setChg(null)

  const save = () => {
    const t = (g.note || '').trim()
    if (same) {
      if (t !== infraText(c, s)) update(c.key, { infraNote: t }, { type: 'Field change', text: 'Status description updated', detail: t || '(cleared)' })
    } else {
      if (blocked) return
      const patch: Partial<DvProject> = { infra: g.to, infraNote: t }
      if (need) {
        const rt = s.rules.remTime
        const O = offs(c, s)
        const r = g.start + 'T' + rt
        const ds = lad(c, s).map((_, i) => (i === 0 ? TODAY + 'T' + rt : addH(r, O[i] - (O[1] || 0), rt)))
        Object.assign(patch, {
          from: 'Client',
          step: 0,
          act: ladderNames(s)[0],
          seqStart: TODAY + 'T' + rt,
          dates: Object.fromEntries(ds.map((v, i) => [i, v])),
          actDate: TODAY,
          reminder: r,
          overdue: g.start < TODAY,
          initDue: due,
          latestDue: null,
          moved: null,
        } satisfies Partial<DvProject>)
      }
      update(c.key, patch, {
        type: 'Field change',
        text: 'Status changed to ' + g.to,
        detail:
          'Was: ' +
          (c.infra || '—') +
          (need ? ' · Initial due ' + fmtD(due) + ' · first reminder ' + fmtD(g.start) : '') +
          (t ? ' · Reason: ' + t : ''),
      })
    }
    setChg(null)
  }

  return (
    <>
      <div onClick={cancel} className="fixed inset-0 z-[60] animate-fade-in bg-[rgba(27,45,69,0.38)]" />
      <div
        role="dialog"
        data-testid="status-modal"
        className="fixed left-1/2 top-1/2 z-[61] w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 rounded-[18px] bg-white px-[22px] pb-[18px] pt-[22px] font-normal text-ink shadow-[0_30px_80px_rgba(0,0,0,0.25),0_0_0_0.5px_rgba(0,0,0,0.08)]"
      >
        <div className="text-[12px] text-muted">{c.name}</div>
        <div className="mt-0.5 text-[19px] font-bold tracking-[-0.02em]">{same ? 'Edit status description' : 'Change status'}</div>
        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <span className="rounded-md px-[9px] py-[3px] text-[12px] font-semibold" style={{ color: ft[0], background: ft[1], opacity: same ? 0 : 1 }}>
            {same ? '' : c.infra}
          </span>
          <span className="text-[13px] text-slate">{same ? '' : '→'}</span>
          <span className="rounded-md px-[9px] py-[3px] text-[12px] font-semibold" style={{ color: tt[0], background: tt[1] }}>
            {g.to}
          </span>
        </div>
        {need && (
          <div className="mt-[18px] grid grid-cols-2 gap-3">
            <label className="block">
              <div className="text-[13px] font-semibold">Initial due date</div>
              <div className="mt-0.5 text-[12px] text-muted">Fixed once saved.</div>
              <input
                type="date"
                aria-label="Initial due date"
                value={due}
                disabled={dueFixed}
                onChange={e => set({ due: e.target.value })}
                className={dateInput}
                style={{ opacity: dueFixed ? 0.7 : 1 }}
              />
            </label>
            <label className="block">
              <div className="text-[13px] font-semibold">First reminder</div>
              <div className="mt-0.5 text-[12px] text-muted">Later steps follow the sequence.</div>
              <input type="date" aria-label="First reminder" value={g.start} onChange={e => set({ start: e.target.value })} className={dateInput} />
            </label>
          </div>
        )}
        <div className="mt-[18px] text-[13px] font-semibold">{same ? 'Description' : 'Reason'}</div>
        {!same && <div className="mt-0.5 text-[12px] text-muted">{s.rules.requireNote ? 'Why did it move? Required.' : 'Why did it move? Optional.'}</div>}
        <textarea
          value={g.note}
          onChange={e => set({ note: e.target.value })}
          rows={5}
          aria-label={same ? 'Description' : 'Reason'}
          placeholder={same ? "What's happening at this status?" : 'Why did it move?'}
          className="mt-1.5 w-full resize-y rounded-xl border-0 bg-canvas px-3 py-2.5 text-[14px] leading-normal text-ink outline-0 focus:shadow-[0_0_0_2px_#4870E8]"
        />
        <div className="mt-1.5 flex items-center gap-2.5">
          <span className="flex-1 text-[12px] text-muted">
            {def
              ? g.note === def
                ? 'Pre-filled from Settings. Edit it for this project if needed.'
                : 'Edited for this project.'
              : 'No default in Settings for this status.'}
          </span>
          {!!def && g.note !== def && (
            <button type="button" onClick={() => set({ note: def })} className="cursor-pointer border-0 bg-transparent p-0 text-[12px] font-medium text-blue-ink">
              Use default
            </button>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2.5">
          <button type="button" onClick={cancel} className="cursor-pointer rounded-lg border-0 bg-sky-2 px-4 py-2 text-[13px] font-medium text-ink">
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="cursor-pointer rounded-lg border-0 bg-blue px-[18px] py-2 text-[13px] font-semibold text-white hover:bg-blue-600"
            style={{ opacity: blocked ? 0.4 : 1 }}
          >
            Save &amp; log
          </button>
        </div>
      </div>
    </>
  )
}
