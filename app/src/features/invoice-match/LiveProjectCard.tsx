import { short } from '../../lib/dates'
import { IM_HOST, IM_LIVE, IM_NAME } from './data'

/** The live chip used on the card and in the project header. */
export function LiveDot({ label = 'Live', className = '' }: { label?: string; className?: string }) {
  return (
    <span className={'inline-flex h-5 flex-none items-center gap-[5px] rounded-[10px] bg-[#DFF1EA] px-[7px] text-[11px] font-extrabold text-[#195040] ' + className}>
      <span className="size-1.5 rounded-full bg-[#3F9079]" />
      {label}
    </span>
  )
}

/**
 * The portal card of the delivered, live InvoiceMatch project: completed,
 * uptime, version and support hours left, and "Open project" in green.
 */
export function LiveProjectCard({ onOpen }: { onOpen: () => void }) {
  const facts = [
    { l: 'Uptime', v: IM_LIVE.uptime, c: '#195040' },
    { l: 'Version', v: IM_LIVE.version, c: '#1B2D45' },
    { l: 'Support left', v: IM_LIVE.supportLeft, c: '#1B2D45' },
  ]
  return (
    <article aria-label={IM_NAME} className="flex flex-col gap-3 rounded-2xl bg-white p-5 shadow-[0_0_0_1.5px_#D6DEE8]">
      <div className="flex items-start gap-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="text-[17px] font-bold leading-snug text-ink">{IM_NAME}</h2>
          <div className="mt-0.5 truncate text-[13px] text-ink-2">
            Completed {short(IM_LIVE.completed)} · live at {IM_HOST}
          </div>
        </div>
        <span className="inline-flex h-[22px] flex-none items-center gap-1.5 rounded-md bg-[#D6E9E2] px-2 text-[12px] font-bold text-[#195040]">
          <span className="size-1.5 rounded-full bg-[#3F9079]" />
          Completed
        </span>
      </div>
      <div>
        <div className="flex items-center justify-between text-[12.5px] font-semibold text-ink-2">
          <span>Progress</span>
          <span className="tnum">100%</span>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sky-3">
          <div className="h-full w-full rounded-full bg-[#3F9079]" />
        </div>
      </div>
      <dl className="grid grid-cols-3 gap-2">
        {facts.map(x => (
          <div key={x.l} className="min-w-0 rounded-[10px] bg-canvas px-2.5 py-[9px]">
            <dt className="whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.04em] text-muted">{x.l}</dt>
            <dd className="mt-[3px] truncate text-[15px] font-bold" style={{ color: x.c }}>
              {x.v}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-auto flex items-center gap-2 border-t-[1.5px] border-[#EEF3FB] pt-3 text-[12.5px] text-ink-2">
        <span className="min-w-0 truncate">Live · last deployed {IM_LIVE.lastDeployed}</span>
        <LiveDot />
        <button
          type="button"
          onClick={onOpen}
          className="ml-auto h-9 flex-none cursor-pointer rounded-[10px] border-[1.5px] border-line bg-white px-3.5 text-[13px] font-bold text-[#195040] hover:border-[#3F9079]"
        >
          Open project ›
        </button>
      </div>
    </article>
  )
}
