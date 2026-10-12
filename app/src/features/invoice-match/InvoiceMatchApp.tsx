import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { server } from '../../api/server'
import { qk, useSend } from '../../api/queries'
import { initials } from '../../lib/media'
import {
  EXC,
  IM_HOST,
  MONTH_RATES,
  nok,
  REPORT_KPIS,
  shortDate,
  STS,
  stOf,
  SUPPLIER_EXCEPTIONS,
  total,
  type Invoice,
  type InvoiceDecision,
} from './data'
import { Feedback, type FeedbackApi } from './Feedback'
import { MON } from '../../lib/dates'

export type ImPage = 'inbox' | 'review' | 'reports'

export const useInvoiceMatch = () => useQuery({ queryKey: qk.invoiceMatch, queryFn: () => server.get('invoiceMatch') })

const FILTERS: [string, string][] = [
  ['all', 'All'],
  ['exc', 'Needs attention'],
  ['approval', 'Awaiting approval'],
  ['ok', 'Matched'],
  ['hold', 'On hold'],
]

const inFilter = (i: Invoice, f: string) => {
  const s = stOf(i)
  return f === 'all' || (f === 'exc' ? EXC.includes(s) : f === 'ok' ? s === 'auto' || s === 'approved' : s === f)
}

const Dot = ({ c, size = 6 }: { c: string; size?: number }) => (
  <span className="flex-none rounded-full" style={{ width: size, height: size, background: c }} />
)

const card = 'rounded-xl bg-white shadow-[0_0_0_1px_#E3E8EF]'
const btnLight =
  'h-8 cursor-pointer rounded-lg border border-[#D5DCE6] bg-white px-2.5 text-[12.5px] font-semibold text-[#111827] hover:border-[#9CA3AF]'

/**
 * Daco's InvoiceMatch app, as delivered: invoice inbox, three-way match
 * review, reports, and "Send feedback". Embedded in the Clients portal, where
 * it gets a browser frame. Page and invoice come from the caller (the URL).
 */
export function InvoiceMatchApp({
  page,
  sel,
  go,
  me,
  embedded = true,
}: {
  page: ImPage
  sel: string | null
  go: (page: ImPage, sel?: string | null) => void
  me: string
  embedded?: boolean
}) {
  const data = useInvoiceMatch().data
  const send = useSend()
  const rootRef = useRef<HTMLDivElement>(null)
  const fbRef = useRef<FeedbackApi>(null)
  const [f, setF] = useState('all')
  const [q, setQ] = useState('')
  const [note, setNote] = useState('')
  const [toast, setToastText] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const showToast = (t: string) => {
    clearTimeout(toastTimer.current)
    setToastText(t)
    toastTimer.current = setTimeout(() => setToastText(''), 2200)
  }
  useEffect(() => () => clearTimeout(toastTimer.current), [])
  // A new invoice starts with an empty note.
  useEffect(() => setNote(''), [sel, page])

  const INV = data?.invoices ?? []
  const excL = INV.filter(i => EXC.includes(stOf(i)))
  const i = INV.find(x => x.no === sel) || excL[0] || INV[0]
  const urlPath = page === 'inbox' ? '/inbox' : page === 'review' ? '/invoices/' + (i?.no ?? '') : '/reports'
  const ctxLabel = page === 'inbox' ? 'Inbox' : page === 'review' ? 'Match review · ' + (i?.no ?? '') : 'Reports'
  const open = (no: string) => go('review', no)
  const rate = Math.min(99, 80 + INV.filter(x => stOf(x) === 'approved').length)

  const nav: [ImPage, string, number][] = [
    ['inbox', 'Inbox', excL.length],
    ['review', 'Review', 0],
    ['reports', 'Reports', 0],
  ]

  return (
    <div
      ref={rootRef}
      data-testid="invoice-match"
      className="relative overflow-hidden bg-[#F4F6FA] text-[#111827] [font-variant-numeric:tabular-nums]"
      style={{
        fontFamily: "Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
        borderRadius: embedded ? 14 : 0,
        boxShadow: embedded ? '0 0 0 1.5px #D6DEE8,0 18px 40px -24px rgba(27,45,69,0.35)' : 'none',
      }}
    >
      {embedded && (
        <div className="flex h-10 items-center gap-2.5 border-b border-[#D5DCE6] bg-[#E9EDF3] px-3.5" aria-hidden="true">
          <span className="flex gap-1.5">
            {[0, 1, 2].map(k => (
              <span key={k} className="size-2.5 rounded-full bg-[#D5DCE6]" />
            ))}
          </span>
          <span className="mx-auto flex h-[26px] max-w-[460px] flex-1 items-center justify-center gap-1.5 rounded-[7px] bg-white text-[12.5px] text-[#374151]">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#16A34A" strokeWidth="2.6" strokeLinecap="round">
              <rect x="5" y="11" width="14" height="10" rx="2" />
              <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            </svg>
            <span data-testid="im-url" className="truncate">
              {IM_HOST}
              {urlPath}
            </span>
          </span>
          <span className="w-[54px]" />
        </div>
      )}

      <div role="banner" className="flex h-[60px] items-center gap-[18px] bg-[#0F1E3D] px-5 text-white">
        <div className="flex min-w-0 flex-[0_1_auto] items-center gap-2.5">
          <span className="grid size-[30px] flex-none place-items-center rounded-lg bg-[#1D4ED8] text-[13px] font-extrabold">IM</span>
          <span className="flex min-w-0 flex-col leading-[1.1]">
            <span className="truncate text-[15px] font-extrabold tracking-[-0.01em]">InvoiceMatch</span>
            <span className="truncate text-[11px] text-[#A9B8D6]">Daco · Accounts payable</span>
          </span>
        </div>
        <nav aria-label="InvoiceMatch" className="ml-1 flex flex-none gap-0.5">
          {nav.map(([p, t, n]) => {
            const on = page === p
            return (
              <button
                key={p}
                type="button"
                onClick={() => go(p, p === 'review' ? sel : undefined)}
                aria-current={on ? 'page' : undefined}
                className="flex h-9 cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-lg border-0 px-[11px] text-[13.5px] font-semibold hover:!bg-[#1B2E57] hover:!text-white"
                style={{ background: on ? '#1D4ED8' : 'transparent', color: on ? '#fff' : '#C7D2E8' }}
              >
                {t}
                {n > 0 && (
                  <span className="grid h-5 min-w-5 place-items-center rounded-[10px] bg-[#F59E0B] px-1.5 text-[11px] font-extrabold text-[#111827]">{n}</span>
                )}
              </button>
            )
          })}
        </nav>
        <span className="ml-auto flex flex-none items-center gap-2 text-[12.5px] text-[#C7D2E8]">
          <button
            type="button"
            onClick={() => fbRef.current?.start(false)}
            title="Send feedback · capture part of the screen (⌘⇧5)"
            className="inline-flex h-8 cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-[9px] border border-white/[.22] bg-white/[.08] px-3 text-[13px] font-bold text-white hover:bg-white/[.16]"
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
              <path d="M9 12h6M12 9v6" />
            </svg>
            Feedback
          </button>
          <span title={me} className="grid size-[30px] place-items-center rounded-full bg-[#334A7A] text-[11.5px] font-bold text-white">
            {initials(me)}
          </span>
        </span>
      </div>

      <main className="min-h-[560px] px-6 pb-7 pt-[22px]">
        {!data ? (
          <div role="status" aria-busy="true" className="p-12 text-center text-[13.5px] text-[#6B7280]">
            Loading…
          </div>
        ) : page === 'inbox' ? (
          <Inbox INV={INV} excL={excL} rate={rate} f={f} setF={setF} q={q} setQ={setQ} open={open} toast={showToast} />
        ) : page === 'review' && i ? (
          <Review
            i={i}
            INV={INV}
            note={note}
            setNote={setNote}
            go={go}
            decide={(d, msg) => {
              send({ type: 'invoiceMatch.decide', no: i.no, decision: d })
              setNote('')
              if (msg) showToast(msg)
            }}
            me={me}
          />
        ) : (
          <Reports
            INV={INV}
            rate={rate}
            onExport={() => {
              const s = [
                'Invoice,Supplier,Received,Amount,PO,Status',
                ...INV.map(x => [x.no, x.sup, x.date, total(x), x.po, STS[stOf(x)][0]].join(',')),
              ].join('\n')
              try {
                const a = document.createElement('a')
                a.href = URL.createObjectURL(new Blob([s], { type: 'text/csv' }))
                a.download = 'invoicematch-october.csv'
                document.body.appendChild(a)
                a.click()
                a.remove()
                setTimeout(() => URL.revokeObjectURL(a.href), 1000)
              } catch {
                // Downloads blocked: the toast still confirms the click.
              }
              showToast('Report exported')
            }}
          />
        )}
      </main>

      <Feedback ref={fbRef} rootRef={rootRef} embedded={embedded} me={me} pageName={page} ctxLabel={ctxLabel} />

      {toast && (
        <div
          role="status"
          className="fixed bottom-[26px] left-1/2 z-[90] -translate-x-1/2 rounded-[10px] bg-[#0F1E3D] px-4 py-2.5 text-[13px] font-semibold text-white shadow-[0_10px_30px_rgba(15,30,61,0.3)]"
        >
          {toast}
        </div>
      )}
    </div>
  )
}

function Inbox({
  INV,
  excL,
  rate,
  f,
  setF,
  q,
  setQ,
  open,
  toast,
}: {
  INV: Invoice[]
  excL: Invoice[]
  rate: number
  f: string
  setF: (f: string) => void
  q: string
  setQ: (q: string) => void
  open: (no: string) => void
  toast: (t: string) => void
}) {
  const qq = q.trim().toLowerCase()
  const rows = INV.filter(i => inFilter(i, f) && (!qq || (i.no + ' ' + i.sup + ' ' + i.po).toLowerCase().includes(qq)))
  const kpis = [
    { l: 'Invoices in October', v: String(INV.length * 24 + 8), s: nok(INV.reduce((x, y) => x + total(y), 0) * 24), c: '#111827' },
    { l: 'Matched automatically', v: rate + '%', s: 'Target 85%', c: '#166534' },
    { l: 'Needs attention', v: String(excL.filter(x => stOf(x) !== 'approval').length), s: 'Price, quantity or missing PO', c: '#B45309' },
    { l: 'Awaiting approval', v: String(INV.filter(x => stOf(x) === 'approval').length), s: 'Above NOK 15 000', c: '#1E40AF' },
  ]
  const cols = '110px minmax(180px,1.4fr) 110px 120px 110px 170px 70px'
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="m-0 text-[22px] font-extrabold tracking-[-0.02em]">Invoice inbox</h2>
          <div className="mt-0.5 text-[13px] text-[#4B5563]">Every supplier invoice is matched against its purchase order and goods receipt.</div>
        </div>
        <button
          type="button"
          onClick={() => (excL[0] ? open(excL[0].no) : toast('No exceptions left. Nice.'))}
          className="ml-auto h-[38px] cursor-pointer rounded-[9px] border-0 bg-[#1D4ED8] px-3.5 text-[13.5px] font-bold text-white hover:bg-[#1E40AF]"
        >
          Review next exception
        </button>
      </div>
      <div className="mt-[18px] grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
        {kpis.map(k => (
          <div key={k.l} className={card + ' px-4 py-3.5'}>
            <div className="text-[12.5px] font-semibold text-[#4B5563]">{k.l}</div>
            <div className="mt-1.5 text-[26px] font-extrabold tracking-[-0.02em]" style={{ color: k.c }}>
              {k.v}
            </div>
            <div className="mt-0.5 text-[12px] text-[#6B7280]">{k.s}</div>
          </div>
        ))}
      </div>
      <div className={card + ' mt-[18px] overflow-hidden'}>
        <div className="flex flex-wrap items-center gap-2 border-b border-[#EEF1F5] px-3.5 py-3">
          {FILTERS.map(([k, t]) => {
            const on = f === k
            return (
              <button
                key={k}
                type="button"
                aria-pressed={on}
                onClick={() => setF(k)}
                className="flex h-8 cursor-pointer items-center gap-1.5 rounded-2xl border px-3 text-[12.5px] font-semibold"
                style={{ borderColor: on ? '#0F1E3D' : '#D5DCE6', background: on ? '#0F1E3D' : '#fff', color: on ? '#fff' : '#374151' }}
              >
                {t}
                <span className="text-[11.5px] opacity-75">{INV.filter(i => inFilter(i, k)).length}</span>
              </button>
            )
          })}
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search invoice, supplier or PO"
            aria-label="Search invoices"
            className="ml-auto h-[34px] w-[250px] max-w-full rounded-lg border border-[#D5DCE6] bg-[#F9FAFB] px-2.5 text-[13px] text-[#111827] outline-0"
          />
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[820px]" role="table" aria-label="Invoices">
            <div
              role="row"
              className="grid gap-3 bg-[#F9FAFB] px-4 py-2.5 text-[11.5px] font-bold uppercase tracking-[0.04em] text-[#6B7280]"
              style={{ gridTemplateColumns: cols }}
            >
              <span role="columnheader">Invoice</span>
              <span role="columnheader">Supplier</span>
              <span role="columnheader">Received</span>
              <span role="columnheader" className="text-right">
                Amount
              </span>
              <span role="columnheader">PO</span>
              <span role="columnheader">Match status</span>
              <span />
            </div>
            {rows.map(i => {
              const s = STS[stOf(i)]
              return (
                <div
                  key={i.no}
                  role="row"
                  tabIndex={0}
                  onClick={() => open(i.no)}
                  onKeyDown={e => e.key === 'Enter' && open(i.no)}
                  className="grid cursor-pointer items-center gap-3 border-t border-[#EEF1F5] px-4 py-3 text-[13.5px] hover:bg-[#F5F8FF]"
                  style={{ gridTemplateColumns: cols }}
                >
                  <span role="cell" className="font-bold text-[#1D4ED8]">
                    {i.no}
                  </span>
                  <span role="cell" className="min-w-0">
                    <span className="block truncate font-semibold">{i.sup}</span>
                    <span className="block text-[12px] text-[#6B7280]">
                      {i.lines.length} line{i.lines.length > 1 ? 's' : ''}
                    </span>
                  </span>
                  <span role="cell" className="text-[#374151]">
                    {shortDate(i.date)}
                  </span>
                  <span role="cell" className="text-right font-bold">
                    {nok(total(i))}
                  </span>
                  <span role="cell" className="font-semibold" style={{ color: i.po ? '#374151' : '#B91C1C' }}>
                    {i.po || 'No PO'}
                  </span>
                  <span role="cell">
                    <span
                      className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-xl px-[9px] text-[12px] font-bold"
                      style={{ background: s[1], color: s[2] }}
                    >
                      <Dot c={s[3]} />
                      {s[0]}
                    </span>
                  </span>
                  <span role="cell" className="text-right text-[12.5px] font-bold text-[#1D4ED8]">
                    Open ›
                  </span>
                </div>
              )
            })}
            {!rows.length && <div className="p-7 text-center text-[13.5px] text-[#6B7280]">No invoices match these filters.</div>}
          </div>
        </div>
      </div>
    </>
  )
}

function Review({
  i,
  INV,
  note,
  setNote,
  go,
  decide,
  me,
}: {
  i: Invoice
  INV: Invoice[]
  note: string
  setNote: (n: string) => void
  go: (page: ImPage, sel?: string | null) => void
  decide: (d: InvoiceDecision | null, msg?: string) => void
  me: string
}) {
  const ix = INV.indexOf(i)
  const st = stOf(i)
  const s = STS[st]
  const d = i.decision
  const ln = i.lines.map(([dsc, qi, qo, qr, pi, po]) => {
    const qBad = qi !== qr || (!!qo && qi !== qo)
    const pBad = !!po && Math.abs(pi - po) / po > 0.02
    const noPo = !qo
    return {
      d: dsc,
      qi: String(qi),
      qo: qo ? String(qo) : '—',
      qr: qr ? String(qr) : '—',
      pi: nok(pi),
      po: po ? nok(po) : '—',
      qw: qBad ? 800 : 500,
      qc: qBad ? '#B91C1C' : '#111827',
      pw: pBad ? 800 : 500,
      pc: pBad ? '#B45309' : '#111827',
      r: noPo ? 'No purchase order' : qBad ? 'Received ' + qr + ' of ' + qi : pBad ? '+' + Math.round(((pi - po) / po) * 100) + '% over PO' : 'Match',
      rc: noPo || qBad ? '#B91C1C' : pBad ? '#B45309' : '#166534',
      bg: noPo || qBad || pBad ? '#FFFBEB' : '#fff',
    }
  })
  const poT = i.lines.reduce((x, l) => x + l[2] * l[5], 0)
  const grT = i.lines.reduce((x, l) => x + l[3] * l[4], 0)
  const invT = total(i)
  const diff = invT - poT
  const within = Math.abs(diff) <= poT * 0.02
  const docs = [
    { l: 'Invoice', ref: i.no, meta: i.sup, amt: nok(invT), amtC: '#111827', ok: '', okC: '#166534', bd: '#E3E8EF' },
    {
      l: 'Purchase order',
      ref: i.po || 'Missing',
      meta: i.po ? 'Raised by Daco site office' : 'Ask the supplier for a PO number',
      amt: i.po ? nok(poT) : '—',
      amtC: i.po && !within ? '#B45309' : '#111827',
      ok: i.po ? (within ? 'Matches' : (diff > 0 ? '+' : '') + nok(diff)) : 'Missing',
      okC: i.po && within ? '#166534' : '#B45309',
      bd: i.po ? '#E3E8EF' : '#FCA5A5',
    },
    {
      l: 'Goods receipt',
      ref: i.po ? 'GR-' + i.po.slice(3) : '—',
      meta: i.po ? 'Signed on site' : 'No receipt without PO',
      amt: i.po ? nok(grT) : '—',
      amtC: '#111827',
      ok: i.po ? (grT === invT ? 'Matches' : 'Short delivery') : '',
      okC: grT === invT ? '#166534' : '#B91C1C',
      bd: '#E3E8EF',
    },
  ]
  const bad = ln.find(l => l.rc !== '#166534')
  const sumOk = ['auto', 'approved', 'approval'].includes(i.st) && !bad
  const decided = !!d || st === 'auto'
  const cols = 'minmax(200px,1.6fr) repeat(3,110px) repeat(2,120px) 140px'
  const mk = (st2: InvoiceDecision['st'], msg: string) => () => decide({ st: st2, note: note.trim(), by: me }, msg)

  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5">
        <button type="button" onClick={() => go('inbox')} className={btnLight}>
          ‹ Inbox
        </button>
        <div className="min-w-0">
          <div className="text-[12.5px] text-[#4B5563]">
            {i.sup} · received {shortDate(i.date)}
          </div>
          <h2 className="m-0 text-[22px] font-extrabold tracking-[-0.02em]">Invoice {i.no}</h2>
        </div>
        <span
          data-testid="im-status"
          className="inline-flex h-[26px] items-center gap-1.5 rounded-[13px] px-2.5 text-[12.5px] font-bold"
          style={{ background: s[1], color: s[2] }}
        >
          <Dot c={s[3]} size={7} />
          {s[0]}
        </span>
        <span className="ml-auto flex gap-1.5">
          <button type="button" onClick={() => go('review', INV[(ix - 1 + INV.length) % INV.length].no)} className={btnLight}>
            ‹ Previous
          </button>
          <button type="button" onClick={() => go('review', INV[(ix + 1) % INV.length].no)} className={btnLight}>
            Next ›
          </button>
        </span>
      </div>
      <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
        {docs.map(x => (
          <div key={x.l} className="rounded-xl bg-white px-4 py-3.5" style={{ boxShadow: '0 0 0 1px ' + x.bd }}>
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-bold uppercase tracking-[0.04em] text-[#6B7280]">{x.l}</span>
              <span className="ml-auto text-[12px] font-bold" style={{ color: x.okC }}>
                {x.ok}
              </span>
            </div>
            <div className="mt-1.5 text-[16px] font-extrabold">{x.ref}</div>
            <div className="mt-0.5 text-[12.5px] text-[#4B5563]">{x.meta}</div>
            <div className="mt-2.5 text-[20px] font-extrabold" style={{ color: x.amtC }}>
              {x.amt}
            </div>
          </div>
        ))}
      </div>
      <div className={card + ' mt-3.5 overflow-x-auto'}>
        <div className="min-w-[760px]" role="table" aria-label="Invoice lines">
          <div
            role="row"
            className="grid gap-2.5 bg-[#F9FAFB] px-4 py-2.5 text-[11.5px] font-bold uppercase tracking-[0.04em] text-[#6B7280]"
            style={{ gridTemplateColumns: cols }}
          >
            <span role="columnheader">Line</span>
            <span role="columnheader" className="text-right">
              Qty invoiced
            </span>
            <span role="columnheader" className="text-right">
              Qty ordered
            </span>
            <span role="columnheader" className="text-right">
              Qty received
            </span>
            <span role="columnheader" className="text-right">
              Invoice price
            </span>
            <span role="columnheader" className="text-right">
              PO price
            </span>
            <span role="columnheader">Result</span>
          </div>
          {ln.map((l, k) => (
            <div
              key={k}
              role="row"
              className="grid items-center gap-2.5 border-t border-[#EEF1F5] px-4 py-3 text-[13.5px]"
              style={{ gridTemplateColumns: cols, background: l.bg }}
            >
              <span role="cell" className="font-semibold">
                {l.d}
              </span>
              <span role="cell" className="text-right" style={{ fontWeight: l.qw, color: l.qc }}>
                {l.qi}
              </span>
              <span role="cell" className="text-right">
                {l.qo}
              </span>
              <span role="cell" className="text-right" style={{ fontWeight: l.qw, color: l.qc }}>
                {l.qr}
              </span>
              <span role="cell" className="text-right" style={{ fontWeight: l.pw, color: l.pc }}>
                {l.pi}
              </span>
              <span role="cell" className="text-right">
                {l.po}
              </span>
              <span role="cell" className="text-[12.5px] font-bold" style={{ color: l.rc }}>
                {l.r}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="mt-3.5 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(300px,1fr))' }}>
        <div
          className="rounded-xl px-4 py-3.5 text-[13.5px] leading-normal"
          style={{ background: sumOk ? '#DCFCE7' : '#FEF3C7', color: sumOk ? '#14532D' : '#78350F' }}
        >
          <div className="font-extrabold">{sumOk ? 'Three-way match passed' : 'Exception: needs a decision'}</div>
          <div className="mt-0.5">
            {sumOk
              ? 'Invoice, PO and goods receipt agree within tolerance.'
              : !i.po
                ? 'There is no purchase order for this invoice.'
                : bad
                  ? bad.r + ' on ' + bad.d + '.'
                  : ''}
          </div>
          <div className="mt-1.5 text-[12.5px] opacity-85">Tolerance: ±2% on price, exact on quantity.</div>
        </div>
        <div className={card + ' px-4 py-3.5'}>
          {decided ? (
            <div className="text-[13.5px]">
              <span className="font-extrabold">{st === 'auto' ? 'Approved automatically' : s[0]}</span>
              <div className="mt-0.5 text-[#4B5563]">
                {st === 'auto' ? 'Matched on arrival · no action needed' : d ? 'By ' + d.by + (d.note ? ' · “' + d.note + '”' : '') : ''}
              </div>
              {st !== 'auto' && (
                <button type="button" onClick={() => decide(null)} className={btnLight + ' mt-2.5 h-[34px] px-3'}>
                  Undo decision
                </button>
              )}
            </div>
          ) : (
            <>
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                rows={2}
                aria-label="Note"
                placeholder="Note for the supplier or your colleagues (optional)"
                className="w-full resize-y rounded-lg border border-[#D5DCE6] px-2.5 py-[9px] text-[13px] outline-0"
              />
              <div className="mt-2.5 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={mk('approved', 'Invoice ' + i.no + ' approved for payment')}
                  className="h-[38px] cursor-pointer rounded-[9px] border-0 bg-[#16A34A] px-4 text-[13.5px] font-bold text-white hover:bg-[#15803D]"
                >
                  Approve for payment
                </button>
                <button
                  type="button"
                  onClick={mk('hold', 'Invoice ' + i.no + ' put on hold')}
                  className="h-[38px] cursor-pointer rounded-[9px] border border-[#F59E0B] bg-[#FFFBEB] px-3.5 text-[13.5px] font-bold text-[#92400E]"
                >
                  Put on hold
                </button>
                <button
                  type="button"
                  onClick={mk('rejected', 'Invoice ' + i.no + ' rejected and sent back to supplier')}
                  className="h-[38px] cursor-pointer rounded-[9px] border border-[#FCA5A5] bg-[#FEF2F2] px-3.5 text-[13.5px] font-bold text-[#B91C1C]"
                >
                  Reject
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

function Reports({ INV, rate, onExport }: { INV: Invoice[]; rate: number; onExport: () => void }) {
  void INV
  const months = [...MONTH_RATES, rate].map((v, k) => ({
    m: MON[k],
    v: v + '%',
    h: Math.round(((v - 60) / 40) * 100) + '%',
    c: k === 9 ? '#1D4ED8' : '#93C5FD',
    tip: MON[k] + ' 2026 · ' + v + '% matched automatically',
  }))
  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="m-0 text-[22px] font-extrabold tracking-[-0.02em]">Reports</h2>
          <div className="mt-0.5 text-[13px] text-[#4B5563]">Match rate, exceptions and approval time for 2026.</div>
        </div>
        <button type="button" onClick={onExport} className="ml-auto h-[38px] cursor-pointer rounded-[9px] border border-[#D5DCE6] bg-white px-3.5 text-[13.5px] font-bold">
          Export CSV
        </button>
      </div>
      <div className="mt-[18px] grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(170px,1fr))' }}>
        {REPORT_KPIS.map(k => (
          <div key={k.l} className={card + ' px-4 py-3.5'}>
            <div className="text-[12.5px] font-semibold text-[#4B5563]">{k.l}</div>
            <div className="mt-1.5 text-[26px] font-extrabold tracking-[-0.02em]">{k.v}</div>
            <div className="mt-0.5 text-[12px]" style={{ color: k.sc }}>
              {k.s}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3.5 grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))' }}>
        <section className={card + ' p-4'} aria-label="Auto-match rate by month">
          <div className="text-[15px] font-extrabold">Auto-match rate by month</div>
          <div className="text-[12.5px] text-[#4B5563]">Share of invoices matched without a person</div>
          <div className="mt-4 grid h-40 items-end gap-2" style={{ gridTemplateColumns: 'repeat(10,minmax(0,1fr))' }}>
            {months.map(m => (
              <div key={m.m} title={m.tip} className="flex h-full flex-col items-center justify-end gap-1">
                <span className="text-[10.5px] font-bold text-[#374151]">{m.v}</span>
                <span className="w-full rounded-[5px_5px_2px_2px]" style={{ height: m.h, background: m.c }} />
              </div>
            ))}
          </div>
          <div className="mt-1.5 grid gap-2 text-center text-[11px] font-semibold text-[#6B7280]" style={{ gridTemplateColumns: 'repeat(10,minmax(0,1fr))' }}>
            {months.map(m => (
              <span key={m.m}>{m.m}</span>
            ))}
          </div>
        </section>
        <section className={card + ' p-4'} aria-label="Exceptions by supplier">
          <div className="text-[15px] font-extrabold">Exceptions by supplier</div>
          <div className="text-[12.5px] text-[#4B5563]">Last 90 days</div>
          <div className="mt-3 flex flex-col gap-3">
            {SUPPLIER_EXCEPTIONS.map(([n, v, why]) => (
              <div key={n}>
                <div className="flex gap-2 text-[13px]">
                  <span className="min-w-0 flex-1 truncate font-semibold">{n}</span>
                  <span className="text-[#4B5563]">{why}</span>
                  <span className="font-extrabold">{v}</span>
                </div>
                <div className="mt-[5px] h-2 overflow-hidden rounded bg-[#EEF1F5]">
                  <div className="h-full rounded bg-[#F59E0B]" style={{ width: Math.round((v / 9) * 100) + '%' }} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  )
}
