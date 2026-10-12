import { useEffect } from 'react'
import { useCompanies, useDevops, useInternalProjects, useWorkspace } from '../../api/queries'
import { linkedProject } from '../../domain/projects'
import { useUi } from '../../state/ui'
import { deploys, latestRelease, needsToast, useDeployState } from './deploys'
import { useMe } from './useMe'

const ROCKET =
  'M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09zM12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z'

/** How long the toast stays up on its own. */
const SHOW_MS = 9000

/**
 * "… is live": shown once per person when a project linked to one of the
 * page's epics has a new release. "View deployment" switches to that epic and
 * opens the DevOps panel on its Status tab. `showEpicBar` makes sure the epic
 * bar (which holds the panel) is on screen.
 */
export function DeployToast({ showEpicBar }: { showEpicBar: () => void }) {
  const me = useMe()
  const ui = useUi()
  const ws = useWorkspace().data
  const dv = useDevops().data
  const companies = useCompanies().data
  const internal = useInternalProjects().data
  const st = useDeployState()

  const links = ws?.devopsLinks ?? {}
  const linked = [...new Set(Object.values(links))].map(k => dv?.projects.find(p => p.key === k)).filter(p => !!p)
  const due = me.id ? linked.find(p => needsToast(st.marks, me.id, p)) : undefined

  useEffect(() => {
    if (due) deploys.showToast(me.id, due)
  }, [due, me.id])

  useEffect(() => {
    if (!st.toast) return
    const t = setTimeout(deploys.hideToast, SHOW_MS)
    return () => clearTimeout(t)
  }, [st.toast])

  const p = st.toast ? dv?.projects.find(x => x.key === st.toast) : undefined
  const r = latestRelease(p)
  const client = linkedProject(p?.project, companies, internal)?.companyName
  if (!p || !r) return null

  const view = () => {
    const epic = Object.keys(links).find(id => links[id] === p.key)
    deploys.seen(me.id, p)
    if (epic) ui.setEpics([epic])
    showEpicBar()
    deploys.setPanel(true, 'status')
  }

  return (
    <div
      role="status"
      className="fixed bottom-6 right-6 z-[60] flex w-[360px] max-w-[calc(100vw-32px)] animate-dp-in gap-3 rounded-2xl bg-white px-4 py-3.5 shadow-[0_0_0_1.5px_#C9D2DD,0_18px_50px_rgba(27,45,69,0.22)]"
    >
      <span className="grid size-9 flex-none place-items-center rounded-[10px] bg-green-soft text-green-ink">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d={ROCKET} />
        </svg>
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-bold text-ink">
          {client ? client + ' · ' : ''}
          {p.name} {r.v} is live
        </div>
        <div className="mt-0.5 text-[12.5px] text-muted">
          {r.name}.{p.cicd ? ' Deployed automatically.' : ''}
        </div>
        <div className="mt-2.5 flex gap-2">
          <button type="button" onClick={view} className="h-8 cursor-pointer rounded-2xl border-0 bg-ink px-3.5 text-[12.5px] font-bold text-white">
            View deployment
          </button>
          <button
            type="button"
            onClick={deploys.hideToast}
            className="h-8 cursor-pointer rounded-2xl border-0 bg-white px-3 text-[12.5px] font-semibold text-ink shadow-[0_0_0_1.5px_#C9D2DD]"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  )
}
