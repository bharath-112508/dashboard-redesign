import { useMemo } from 'react'
import { useCompanies, useWorkspace } from '../../api/queries'
import { isClientRole } from '../../api/session/access'
import { useSession } from '../../api/session/store'
import { buildScope, type ClientScope } from '../../domain/scope'

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
