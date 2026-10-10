import { useState } from 'react'
import { Link } from 'react-router'
import { useSession } from '../../api/session/store'
import { TONE, type Dashboard, type Kpi } from '../../api/dashboard/model'
import type { Session } from '../../api/types'
import { findPerson } from '../../api/people/directory'
import { CriticalDrawer } from './CriticalDrawer'
import { LogTime } from './LogTime'
import { WidgetView } from './Widgets'
import { useDashboard } from './useDashboard'

/** The Dashboard page. Without a session it shows nothing; the shell redirects to sign-in first. */
export function DashboardPage() {
  const session = useSession()
  if (!session) return null
  return <DashboardView me={session} />
}

function DashboardView({ me }: { me: Session }) {
  const { ready, model, people, tasks, entries, statuses, today } = useDashboard(me)
  const [drawer, setDrawer] = useState<'critical' | 'overdue' | null>(null)
  const person = findPerson(people, me.personId)

  return (
    <main className="mx-auto w-full max-w-[1360px] px-4 pb-14 pt-5 md:px-7">
      <Header model={model} me={me} />

      <KpiRow kpis={model?.kpis} placeholders={me.emp === 'freelancer' ? 3 : 4} onDrawer={setDrawer} />

      {ready && model?.canLog && (
        <div className="mt-4">
          <LogTime
            me={me}
            person={person}
            tickets={tasks.filter(t => !t.parent && t.status !== 'done')}
            statuses={statuses}
            allTasks={tasks}
            todays={entries.filter(e => e.userId === me.personId && e.date === today)}
            today={today}
            dayShort={model.dayShort}
          />
        </div>
      )}

      <div className="mt-4 grid items-start gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(360px,100%),1fr))]">
        {model?.widgets.map(w => (
          <WidgetView key={w.id} widget={w} />
        ))}
      </div>

      {drawer && model && (
        <CriticalDrawer
          title={drawer === 'critical' ? 'Critical tickets' : 'Overdue tickets'}
          sub={drawer === 'critical' ? 'Open tickets marked Critical' : 'Past due date, not done'}
          rows={drawer === 'critical' ? model.critical : model.overdue}
          people={people}
          onClose={() => setDrawer(null)}
        />
      )}
    </main>
  )
}

function Header({ model, me }: { model: Dashboard | null; me: Session }) {
  const org = model?.org
  return (
    <div className="mt-1 flex flex-wrap items-end gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-muted">{model?.dateLine ?? ''}</div>
        <h1 className="mt-1 text-[26px] font-extrabold tracking-[-0.02em] text-ink">
          {model?.greeting ?? `Hello, ${me.name.split(' ')[0]}`}
        </h1>
        <div className="mt-1 text-[14px] text-ink-2">{model?.scope ?? ''}</div>
      </div>
      {org && (
        <span
          className="ml-auto inline-flex h-[26px] items-center gap-1.5 rounded-[7px] pl-2 pr-2.5 text-[12px] font-bold"
          style={{ background: org.client ? '#FBF1D6' : '#E7EEFB', color: org.client ? TONE.amber.ink : '#1B2D45' }}
        >
          <span className="size-1.5 rounded-full" style={{ background: org.client ? TONE.amber.ink : '#1B2D45' }} />
          {org.label}
        </span>
      )}
    </div>
  )
}

const KPI_CELL = 'block min-w-0 px-[18px] py-4 text-left text-ink no-underline shadow-[inset_1.5px_0_0_#E4EAF0] first:shadow-none hover:bg-canvas'
const KPI_FRAME = 'mt-4 grid overflow-hidden rounded-2xl bg-white shadow-[0_0_0_1.5px_#D6DEE8] [grid-template-columns:repeat(auto-fit,minmax(min(200px,100%),1fr))]'

function KpiRow({ kpis, placeholders, onDrawer }: { kpis: Kpi[] | undefined; placeholders: number; onDrawer: (d: 'critical' | 'overdue') => void }) {
  if (!kpis) {
    return (
      <div className={KPI_FRAME} aria-busy="true">
        {Array.from({ length: placeholders }, (_, i) => (
          <div key={i} className={KPI_CELL}>
            <div className="h-3 w-24 rounded bg-sky" />
            <div className="mt-3 h-6 w-16 rounded bg-sky" />
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className={KPI_FRAME}>
      {kpis.map(k => {
        const body = (
          <>
            <div className="flex items-center gap-1.5 text-[11.5px] font-bold uppercase tracking-[0.05em] text-muted">
              <span className="size-2 rounded-[2px]" style={{ background: k.dot }} aria-hidden="true" />
              {k.label}
            </div>
            <div className="mt-1.5 flex items-baseline gap-1.5">
              <span className="text-[24px] font-extrabold tabular-nums tracking-[-0.01em]" style={{ color: k.valueColor ?? '#1B2D45' }}>
                {k.value}
              </span>
              {k.of && <span className="text-[13px] font-semibold text-muted">{k.of}</span>}
            </div>
            <div className="mt-0.5 text-[12.5px] text-muted">{k.sub}</div>
          </>
        )
        if (k.drawer) {
          const open = k.drawer
          return (
            <button key={k.id} type="button" onClick={() => onDrawer(open)} className={`${KPI_CELL} cursor-pointer border-0 bg-transparent`}>
              {body}
            </button>
          )
        }
        return (
          <Link key={k.id} to={k.href} className={KPI_CELL}>
            {body}
          </Link>
        )
      })}
    </div>
  )
}
