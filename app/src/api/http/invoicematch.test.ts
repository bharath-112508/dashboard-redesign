import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '../types'

const { get, put, del } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), del: vi.fn() }))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { get, put, delete: del } }))

const { fetchInvoiceMatch, sendInvoiceMatchCommand } = await import('./invoicematch')
const { INVOICES_SEED } = await import('../../features/invoice-match/data')

const emma: Session = { personId: 'k1', name: 'Emma', email: 'e@x', role: 'cadmin', org: 'Aurora', orgId: 'c1' }
const PROJECTS = [
  { id: 'p1', name: 'Supply Portal', company_id: 'c1', is_archived: false },
  { id: 'p9', name: 'InvoiceMatch', company_id: 'c1', is_archived: false },
]

beforeEach(() => {
  for (const f of [get, put, del]) f.mockReset()
  get.mockImplementation(async (path: string) => {
    if (path.startsWith('/projects')) return PROJECTS
    if (path === '/invoicematch/p9/decisions') return [{ no: 'INV-20417', st: 'approved', note: 'OK', by: 'Emma Lindqvist' }]
    throw new Error(path)
  })
})

describe('fetchInvoiceMatch', () => {
  it("reads the sample invoices with the decisions saved on the InvoiceMatch project", async () => {
    const { invoices } = await fetchInvoiceMatch(emma)
    expect(invoices.map(i => i.no)).toEqual(INVOICES_SEED.map(i => i.no))
    expect(invoices.find(i => i.no === 'INV-20417')?.decision).toEqual({ st: 'approved', note: 'OK', by: 'Emma Lindqvist' })
    expect(invoices.find(i => i.no === 'INV-20418')?.decision).toBeUndefined()
  })

  it('reads no decisions when there is no InvoiceMatch project', async () => {
    get.mockImplementation(async () => [PROJECTS[0]])
    expect((await fetchInvoiceMatch(emma)).invoices).toEqual(INVOICES_SEED)
  })
})

describe('sendInvoiceMatchCommand', () => {
  it('saves and undoes a decision on the project', async () => {
    await sendInvoiceMatchCommand({ type: 'invoiceMatch.decide', no: 'INV-20415', decision: { st: 'hold', note: 'Ask', by: 'Emma' } })
    expect(put).toHaveBeenCalledWith('/invoicematch/p9/decisions/INV-20415', { st: 'hold', note: 'Ask' })
    await sendInvoiceMatchCommand({ type: 'invoiceMatch.decide', no: 'INV-20415', decision: null })
    expect(del).toHaveBeenCalledWith('/invoicematch/p9/decisions/INV-20415')
  })
})
