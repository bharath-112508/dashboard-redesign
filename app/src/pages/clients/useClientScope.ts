import { createContext, useContext, useMemo } from 'react'
import { useCompanies, useWorkspace } from '../../api/queries'
import { isClientRole } from '../../api/session/access'
import { useSession } from '../../api/session/store'
import { buildScope, type ClientScope } from '../../domain/scope'
import { useScopedWorkspace } from '../../state/access'
import { useUi } from '../../state/ui'
import { hasInvoiceMatch, IM_COMPANY, IM_EPIC_IDS, isImSelection } from '../../features/invoice-match/data'

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

/** The board scope while the InvoiceMatch project is open: its epics only, no DevOps link, no questions. */
const IM_SCOPE: ClientScope = { companyId: IM_COMPANY, epicIds: IM_EPIC_IDS, devopsKeys: [] }

/**
 * Whether the Clients page shows the delivered InvoiceMatch project (every
 * picked epic is one of its epics, and the viewer may see it), and the scope
 * the page then uses. Team roles may open it; clients only from its company.
 */
export function useProjectScope(): { im: boolean; scope: ClientScope | null } {
  const base = useClientScope()
  const session = useSession()
  const companies = useCompanies().data
  const epSel = useUi().epSel
  const allowed = !session || !isClientRole(session.role) || hasInvoiceMatch(companies?.find(c => c.id === session.orgId))
  const im = allowed && isImSelection(epSel)
  return useMemo(() => ({ im, scope: im ? IM_SCOPE : base }), [im, base])
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
