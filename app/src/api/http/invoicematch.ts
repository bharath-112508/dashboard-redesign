import { api } from './client'
import { liveProjects } from './companies'
import { IM_NAME, INVOICES_SEED, type InvoiceDecision, type InvoiceMatchDb } from '../../features/invoice-match/data'
import type { InvoiceMatchCommand } from '../../features/invoice-match/commands'
import type { Session } from '../types'

/**
 * The InvoiceMatch live-app demo in API mode: the app's fixed sample invoices,
 * with the decisions saved on the backend for the project named InvoiceMatch.
 */

/** The InvoiceMatch project the signed-in person can see (the backend scopes the list). */
const imProjectId = async () => (await liveProjects()).find(p => p.name === IM_NAME)?.id ?? null

export const fetchInvoiceMatch = async (session: Session | null): Promise<InvoiceMatchDb> => {
  const id = session ? await imProjectId() : null
  if (!id) return { invoices: INVOICES_SEED }
  const saved = await api.get<({ no: string } & InvoiceDecision)[]>(`/invoicematch/${id}/decisions`)
  const byNo = new Map(saved.map(({ no, st, note, by }) => [no, { st, note, by }]))
  return { invoices: INVOICES_SEED.map(i => (byNo.has(i.no) ? { ...i, decision: byNo.get(i.no) } : i)) }
}

export const isInvoiceMatchApiCommand = (cmd: { type: string }): cmd is InvoiceMatchCommand => cmd.type === 'invoiceMatch.decide'

export const sendInvoiceMatchCommand = async (cmd: InvoiceMatchCommand): Promise<{ id?: string }> => {
  const id = await imProjectId()
  if (!id) throw new Error('There is no InvoiceMatch project.')
  const path = `/invoicematch/${id}/decisions/${encodeURIComponent(cmd.no)}`
  if (cmd.decision) await api.put(path, { st: cmd.decision.st, note: cmd.decision.note })
  else await api.delete(path)
  return {}
}
