import { Navigate, useNavigate, useParams } from 'react-router'
import { useCompanies } from '../../api/queries'
import { useSession } from '../../api/session/store'
import { Icon, PATHS } from '../../components/ui'
import { useIsClient } from '../../state/access'
import { clientsPath, useUi } from '../../state/ui'
import { hasInvoiceMatch, IM_BASE, IM_LIVE, IM_NAME, imEpicIds, isImProject } from './data'
import { InvoiceMatchApp, type ImPage } from './InvoiceMatchApp'

/**
 * The InvoiceMatch live app inside the Clients portal (`/clients/live/invoicematch/…`).
 * Only Daco's people and the Viljetech team can open it. The app's page is the
 * rest of the path: `inbox`, `review`, `invoices/<no>` or `reports`.
 */
export function LiveAppPage() {
  const session = useSession()
  const isClient = useIsClient()
  const companies = useCompanies().data
  const navigate = useNavigate()
  const ui = useUi()
  const rest = useParams()['*'] ?? ''
  const [seg, arg] = rest.split('/')

  if (!companies)
    return (
      <main className="px-7 pb-14 pt-6">
        <div role="status" aria-busy="true" className="p-12 text-center text-[14px] text-muted">
          Loading…
        </div>
      </main>
    )
  const company = isClient ? companies.find(c => c.id === session?.orgId) : companies.find(c => hasInvoiceMatch(c))
  if (!company || !hasInvoiceMatch(company)) return <Navigate to="/clients" replace />
  const project = company.projects.find(isImProject)!

  const page: ImPage = seg === 'reports' ? 'reports' : seg === 'invoices' || seg === 'review' ? 'review' : 'inbox'
  const sel = seg === 'invoices' && arg ? decodeURIComponent(arg) : null
  const go = (p: ImPage, no?: string | null) =>
    navigate(IM_BASE + '/' + (p === 'review' ? (no ? 'invoices/' + encodeURIComponent(no) : 'review') : p))
  const backToProject = () => {
    ui.setEpics(imEpicIds(project))
    navigate(clientsPath('board', project.id))
  }

  return (
    <main className="px-7 pb-14 pt-5">
      <div className="mx-auto flex w-full max-w-[1320px] flex-col gap-3.5">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={backToProject}
            className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] border-line bg-white pl-1.5 pr-2.5 text-[12.5px] font-semibold text-ink hover:border-blue hover:text-blue-ink"
          >
            <Icon d={PATHS.back} size={14} sw={2.6} />
            Back to {IM_NAME} project
          </button>
          <div className="min-w-0">
            <div className="text-[12px] font-semibold text-muted">{company?.name} · Completed project · Live</div>
            <h1 className="m-0 text-[22px] font-bold tracking-[-0.02em] text-ink">{IM_NAME}</h1>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#DFF1EA] py-[3px] pl-2 pr-2.5 text-[12px] font-bold text-[#195040]">
            <span className="size-1.5 rounded-full bg-[#3F9079]" />
            Live · {IM_LIVE.uptime} uptime
          </span>
          <span className="ml-auto text-[12.5px] text-muted">
            Use <b>Feedback</b> in the app to report a bug with a screenshot
          </span>
        </div>
        <InvoiceMatchApp page={page} sel={sel} go={go} me={session?.name ?? 'Ingrid Solberg'} />
      </div>
    </main>
  )
}
