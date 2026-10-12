import { createContext, useContext, useMemo } from 'react'
import { useCompanies, useWorkspace } from '../../api/queries'
import { isClientRole } from '../../api/session/access'
import { useSession } from '../../api/session/store'
import { buildScope, type ClientScope } from '../../domain/scope'
import { useScopedWorkspace } from '../../state/access'
import { useProjectParam, useUi } from '../../state/ui'
import type { ClientProject, Company } from '../../api/types'
import { hasInvoiceMatch, IM_EPIC_IDS, IM_PROJECT_ID, isImSelection } from '../../features/invoice-match/data'

/** The scope for the signed-in client, or null for team roles. */
export function useClientScope(): ClientScope | null {
  const session = useSession()
  const companies = useCompanies().data
  const ws = useWorkspace().data
  return useMemo(() => {
    if (!session || !isClientRole(session.role)) return null
    return buildScope(session.orgId, companies ?? [], ws)
  }, [session, companies, ws])
}

/**
 * The project open on the Clients page (`?project=<id>`), looked up in the
 * Companies data: a client finds only their own company's projects, a team
 * role any company's. Null when there is no parameter or it matches nothing.
 */
export function useOpenProject(): { company: Company; project: ClientProject } | null {
  const session = useSession()
  const companies = useCompanies().data
  const { id } = useProjectParam()
  return useMemo(() => {
    if (!id || !companies) return null
    const client = !!session && isClientRole(session.role)
    for (const company of companies) {
      if (client && company.id !== session.orgId) continue
      const project = company.projects.find(p => p.id === id)
      if (project) return { company, project }
    }
    return null
  }, [id, companies, session])
}

/**
 * Whether the Clients page shows the delivered InvoiceMatch project, and the
 * scope the page then uses (its epics only, no DevOps link, no questions).
 * The open project (`?project=`) decides; without one, a selection of only its
 * epics does. Team roles may open it; clients only from its company.
 */
export function useProjectScope(): { im: boolean; scope: ClientScope | null } {
  const base = useClientScope()
  const session = useSession()
  const companies = useCompanies().data
  const open = useOpenProject()
  const { id } = useProjectParam()
  const epSel = useUi().epSel
  const allowed = !session || !isClientRole(session.role) || hasInvoiceMatch(companies?.find(c => c.id === session.orgId))
  const im = open ? open.project.id === IM_PROJECT_ID : !id && allowed && isImSelection(epSel)
  const companyId = open?.company.id ?? companies?.find(c => hasInvoiceMatch(c))?.id ?? null
  return useMemo(() => ({ im, scope: im ? { companyId, epicIds: IM_EPIC_IDS, devopsKeys: [] } : base }), [im, base, companyId])
}

/** Set by ClientsLayout: true while the InvoiceMatch project is open. */
export const ImModeContext = createContext(false)
export const useImMode = () => useContext(ImModeContext)

/**
 * The workspace the Clients page lists epics and sprints from: the
 * InvoiceMatch epics while that project is open, every other epic otherwise.
 */
export function useProjectWorkspace() {
  const ws = useScopedWorkspace()
  const im = useImMode()
  return useMemo(
    () =>
      ws && !im
        ? { ...ws, epics: ws.epics.filter(e => !IM_EPIC_IDS.includes(e.id)), sprints: ws.sprints.filter(s => !IM_EPIC_IDS.includes(s.epic)) }
        : ws,
    [ws, im],
  )
}
