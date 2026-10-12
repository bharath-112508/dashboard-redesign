import type { Db } from '../../api/types'
import type { Resource } from '../../api/commands'
import { IM_EPICS, IM_EPIC_IDS, IM_SPRINTS, imTasks, INVOICES_SEED, type InvoiceDecision, type InvoiceMatchDb } from './data'

/** The live app's data is a collection of the shared db. Declared here so api/types.ts stays unchanged. */
declare module '../../api/types' {
  interface Db {
    invoiceMatch: InvoiceMatchDb
  }
}

/** Writes the InvoiceMatch live app makes. Feedback is not one: it is a normal `task.create` of a client bug. */
export type InvoiceMatchCommand =
  /** Approves, holds or rejects an invoice; `decision: null` undoes the decision. */
  { type: 'invoiceMatch.decide'; no: string; decision: InvoiceDecision | null }

export const touchesInvoiceMatch = (cmd: { type: string }): Resource[] =>
  cmd.type === 'invoiceMatch.decide' ? ['invoiceMatch'] : []

export const reduceInvoiceMatch = (db: Db, input: { type: string }): Db => {
  if (input.type !== 'invoiceMatch.decide') return db
  const c = input as InvoiceMatchCommand
  const im = db.invoiceMatch ?? { invoices: [] }
  return {
    ...db,
    invoiceMatch: {
      ...im,
      invoices: im.invoices.map(i => {
        if (i.no !== c.no) return i
        if (!c.decision) {
          const { decision: _drop, ...rest } = i
          return rest
        }
        return { ...i, decision: c.decision }
      }),
    },
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Adds the InvoiceMatch project (its epics, sprints and delivered tickets) and
 * the live app's invoices to a db: the seed, or a store saved before they
 * existed (run from migrate3 on every load, so it only adds what is missing).
 * The tickets are numbered after the highest ticket id already there.
 */
export const withInvoiceMatch = <T extends object>(input: T): T & { invoiceMatch: InvoiceMatchDb } => {
  const v = input as Record<string, unknown>
  let out = v
  const ws = v.workspace
  if (isObj(ws) && Array.isArray(ws.epics) && Array.isArray(ws.sprints) && Array.isArray(v.tasks)) {
    const hasEpics = ws.epics.some(e => isObj(e) && IM_EPIC_IDS.includes(String(e.id)))
    if (!hasEpics) {
      const tasks = v.tasks as { id?: unknown; parent?: unknown }[]
      const maxId = Math.max(0, ...tasks.filter(t => isObj(t) && !t.parent).map(t => Number(t.id) || 0))
      out = {
        ...out,
        workspace: { ...ws, epics: [...ws.epics, ...IM_EPICS], sprints: [...ws.sprints, ...IM_SPRINTS] },
        tasks: [...tasks, ...imTasks(maxId + 1)],
      }
    }
  }
  if (!isObj(v.invoiceMatch) || !Array.isArray(v.invoiceMatch.invoices)) {
    out = { ...out, invoiceMatch: { invoices: structuredClone(INVOICES_SEED) } }
  }
  return out as T & { invoiceMatch: InvoiceMatchDb }
}
