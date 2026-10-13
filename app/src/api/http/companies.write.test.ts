import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientProject, Company, CompanyContact, InternalProject } from '../types'

const { get, post, patch, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { get, post, patch, delete: del } }))
const session = vi.hoisted(() => ({ personId: 'a0', name: 'Admin', email: 'a@x', role: 'super', org: 'Viljetech' }))
vi.mock('../session/store', () => ({ readSession: () => session }))

const { sendCompanyCommand, randomPassword, randomIndex } = await import('./companies')

const TODAY = '2026-10-13'
const company = (over: Partial<Company> = {}): Company => ({
  id: 'tmp-c',
  name: 'Redesign Test AB',
  industry: 'Testing',
  country: 'Sweden',
  web: 'test.example',
  p: 0,
  notes: '',
  contacts: [],
  projects: [],
  ourRoles: {},
  archived: false,
  archivedAt: null,
  ...over,
})
const contact = (over: Partial<CompanyContact> = {}): CompanyContact => ({
  personId: null,
  name: 'Kari Berg',
  role: 'Head of digital',
  email: 'kari@test.example',
  projects: [],
  ...over,
})
const backendProject = (id: string, company_id: string, member_ids: string[] = []) => ({
  id,
  name: id,
  status: 'active',
  is_archived: false,
  start_date: TODAY,
  end_date: null,
  member_ids,
  company_id,
})

const POLICY = { password_policy: { min_length: 10, max_length: 12, require_upper: true, require_lower: true, require_number: true, require_special: true } }

beforeEach(() => {
  session.role = 'super'
  for (const m of [get, post, patch, del]) m.mockReset()
  get.mockImplementation(async (path: string) => {
    if (path === '/settings/public') return POLICY
    throw new Error(`unexpected GET ${path}`)
  })
})

describe('company.create', () => {
  it('creates the company with its profile and returns the backend id', async () => {
    post.mockResolvedValueOnce({ id: 'c1' })
    const r = await sendCompanyCommand({ type: 'company.create', company: company() }, TODAY)
    expect(post).toHaveBeenCalledWith('/companies', { name: 'Redesign Test AB', industry: 'Testing', country: 'Sweden', website: 'test.example', notes: '' })
    expect(r).toEqual({ id: 'c1' })
  })

  it('adds the main contact as a client contact when it has an email', async () => {
    post.mockResolvedValueOnce({ id: 'c1' }).mockResolvedValueOnce({ id: 'u9' })
    await sendCompanyCommand({ type: 'company.create', company: company({ contacts: [contact({ role: 'Main contact' })] }) }, TODAY)
    expect(post).toHaveBeenNthCalledWith(2, '/companies/c1/representatives', {
      email: 'kari@test.example',
      full_name: 'Kari Berg',
      title: 'Main contact',
      initial_password: expect.any(String),
      // The contact chooses their own password from the emailed link.
      send_invite: true,
    })
  })

  it("makes the starting password fit the backend's password length policy", async () => {
    post.mockResolvedValueOnce({ id: 'c1' }).mockResolvedValueOnce({ id: 'u9' })
    await sendCompanyCommand({ type: 'company.create', company: company({ contacts: [contact()] }) }, TODAY)
    const body = post.mock.calls[1][1] as { initial_password: string }
    expect(body.initial_password.length).toBeGreaterThanOrEqual(10)
    expect(body.initial_password.length).toBeLessThanOrEqual(12)
  })

  it('still opens the new company when adding its main contact fails', async () => {
    const { ApiError } = await import('./client')
    post.mockResolvedValueOnce({ id: 'c1' }).mockRejectedValueOnce(new ApiError(403, 'FORBIDDEN', 'no'))
    const r = await sendCompanyCommand({ type: 'company.create', company: company({ contacts: [contact()] }) }, TODAY)
    expect(r).toEqual({ id: 'c1' })
  })

  it('skips a main contact without an email, since a backend contact needs one', async () => {
    post.mockResolvedValueOnce({ id: 'c1' })
    await sendCompanyCommand({ type: 'company.create', company: company({ contacts: [contact({ email: '' })] }) }, TODAY)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('passes a refusal from the backend on (e.g. a duplicate name)', async () => {
    const { ApiError } = await import('./client')
    post.mockRejectedValueOnce(new ApiError(409, 'DUPLICATE_RESOURCE', 'A company with this name already exists'))
    await expect(sendCompanyCommand({ type: 'company.create', company: company() }, TODAY)).rejects.toMatchObject({ status: 409 })
  })
})

describe('company.update and company.archive', () => {
  it('patches only the given profile fields', async () => {
    patch.mockResolvedValueOnce({})
    await sendCompanyCommand({ type: 'company.update', id: 'c1', patch: { notes: 'New notes', web: 'x.example' } }, TODAY)
    expect(patch).toHaveBeenCalledWith('/companies/c1', { notes: 'New notes', website: 'x.example' })
  })

  it("updates the existing main contact's name and email by person id", async () => {
    patch.mockResolvedValue({})
    await sendCompanyCommand(
      { type: 'company.update', id: 'c1', patch: {}, main: { name: 'Kari Berg', email: 'kari.new@test.example' }, mainPersonId: 'u9' },
      TODAY,
    )
    expect(patch).toHaveBeenCalledWith('/users/u9', { full_name: 'Kari Berg', email: 'kari.new@test.example' })
    expect(post).not.toHaveBeenCalled()
  })

  it('leaves the main contact alone when the form did not change it (a non-admin may not edit users)', async () => {
    patch.mockResolvedValue({})
    await sendCompanyCommand(
      {
        type: 'company.update',
        id: 'c1',
        patch: { notes: 'n' },
        main: { name: 'Kari Berg', email: 'kari@test.example' },
        mainBefore: { name: 'Kari Berg', email: 'kari@test.example' },
        mainPersonId: 'u9',
      },
      TODAY,
    )
    expect(patch).toHaveBeenCalledTimes(1)
    expect(patch).toHaveBeenCalledWith('/companies/c1', { notes: 'n' })
  })

  it('sends only the email when only the email changed', async () => {
    patch.mockResolvedValue({})
    await sendCompanyCommand(
      {
        type: 'company.update',
        id: 'c1',
        patch: {},
        main: { name: 'Kari Berg', email: 'kari.new@test.example' },
        mainBefore: { name: 'Kari Berg', email: 'kari@test.example' },
        mainPersonId: 'u9',
      },
      TODAY,
    )
    expect(patch).toHaveBeenCalledWith('/users/u9', { email: 'kari.new@test.example' })
  })

  it('adds a main contact when the company has none yet', async () => {
    post.mockResolvedValueOnce({ id: 'u10' })
    await sendCompanyCommand({ type: 'company.update', id: 'c1', patch: {}, main: { name: 'New Person', email: 'new@test.example' }, mainPersonId: null }, TODAY)
    expect(post).toHaveBeenCalledWith('/companies/c1/representatives', expect.objectContaining({ email: 'new@test.example', full_name: 'New Person', send_invite: true }))
  })


  it('archives with the archive endpoint and restores by setting the status back', async () => {
    post.mockResolvedValueOnce({})
    patch.mockResolvedValueOnce({})
    await sendCompanyCommand({ type: 'company.archive', id: 'c1', archived: true, at: TODAY }, TODAY)
    await sendCompanyCommand({ type: 'company.archive', id: 'c1', archived: false, at: null }, TODAY)
    expect(post).toHaveBeenCalledWith('/companies/c1/archive')
    expect(patch).toHaveBeenCalledWith('/companies/c1', { status: 'active' })
  })
})

describe('company contacts', () => {
  it('adds a new admin contact on two projects: creates them, makes them client admin, rosters them', async () => {
    post.mockResolvedValueOnce({ id: 'u9' }).mockResolvedValue({})
    await sendCompanyCommand(
      { type: 'company.contact.save', companyId: 'c1', index: null, contact: contact({ admin: true, projects: ['p1', 'p2'] }) },
      TODAY,
    )
    expect(post.mock.calls.map(c => c[0])).toEqual([
      '/companies/c1/representatives',
      '/users/u9/change-role',
      '/projects/p1/representatives',
      '/projects/p2/representatives',
    ])
    expect(post).toHaveBeenCalledWith('/users/u9/change-role', { new_role: 'client' })
    expect(post).toHaveBeenCalledWith('/projects/p1/representatives', { add: ['u9'] })
  })

  it("edits a contact: name and title, and only the project changes", async () => {
    get.mockResolvedValueOnce({ id: 'u9', full_name: 'Kari', email: 'kari@test.example', role: 'representative', status: 'active', projects: [{ id: 'p1' }, { id: 'p2' }] })
    patch.mockResolvedValue({})
    post.mockResolvedValue({})
    await sendCompanyCommand(
      { type: 'company.contact.save', companyId: 'c1', index: 0, contact: contact({ personId: 'u9', name: 'Kari B', role: 'CTO', projects: ['p2', 'p3'] }) },
      TODAY,
    )
    expect(get).toHaveBeenCalledWith('/companies/c1/representatives/u9')
    expect(patch).toHaveBeenCalledWith('/users/u9', { full_name: 'Kari B', client_profile: { title: 'CTO' } })
    expect(post).toHaveBeenCalledWith('/projects/p1/representatives', { remove: ['u9'] })
    expect(post).toHaveBeenCalledWith('/projects/p3/representatives', { add: ['u9'] })
    expect(post).not.toHaveBeenCalledWith('/projects/p2/representatives', expect.anything())
    expect(post).not.toHaveBeenCalledWith('/users/u9/change-role', expect.anything())
  })

  it('removes the contact by their person id, never by position', async () => {
    del.mockResolvedValueOnce(undefined)
    await sendCompanyCommand({ type: 'company.contact.remove', companyId: 'c1', index: 1, personId: 'u2' }, TODAY)
    expect(del).toHaveBeenCalledWith('/companies/c1/representatives/u2')
    expect(get).not.toHaveBeenCalledWith(expect.stringContaining('/representatives?'))
  })

  it('refuses to remove a contact it cannot identify', async () => {
    await expect(sendCompanyCommand({ type: 'company.contact.remove', companyId: 'c1', index: 0, personId: null }, TODAY)).rejects.toThrow()
    expect(del).not.toHaveBeenCalled()
  })

  it('refuses to make a client admin a regular contact before changing anything (the backend cannot yet)', async () => {
    get.mockResolvedValueOnce({ id: 'u9', full_name: 'Kari', email: 'k@x', role: 'client', status: 'active', projects: [] })
    await expect(
      sendCompanyCommand({ type: 'company.contact.save', companyId: 'c1', index: 0, contact: contact({ personId: 'u9', admin: false }) }, TODAY),
    ).rejects.toMatchObject({ status: 403 })
    expect(patch).not.toHaveBeenCalled()
    expect(post).not.toHaveBeenCalled()
  })

  it('refuses a new admin contact from someone who is not an admin, before creating anyone', async () => {
    session.role = 'pm'
    await expect(
      sendCompanyCommand({ type: 'company.contact.save', companyId: 'c1', index: null, contact: contact({ admin: true }) }, TODAY),
    ).rejects.toMatchObject({ status: 403 })
    expect(post).not.toHaveBeenCalled()
  })
})

describe('Viljetech staff on a company', () => {
  it("sets one person's role with the one-at-a-time endpoint and syncs only this company's projects", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/projects?company_id=c1&limit=100&page=1') return [backendProject('p1', 'c1', ['u1']), backendProject('p2', 'c1')]
      throw new Error(path)
    })
    post.mockResolvedValue({})
    await sendCompanyCommand({ type: 'company.responsible.save', companyId: 'c1', personId: 'u1', role: 'Developer', projects: ['p2'] }, TODAY)
    expect(post).toHaveBeenCalledWith('/companies/c1/responsibles', { user_id: 'u1', role: 'developer' })
    expect(post).toHaveBeenCalledWith('/projects/p1/members', { remove: ['u1'] })
    expect(post).toHaveBeenCalledWith('/projects/p2/members', { add: ['u1'] })
    expect(patch).not.toHaveBeenCalled()
  })

  it('removes the person from the company and from every company project', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/projects?company_id=c1&limit=100&page=1') return [backendProject('p1', 'c1', ['u1']), backendProject('p2', 'c1')]
      throw new Error(path)
    })
    del.mockResolvedValue(undefined)
    post.mockResolvedValue({})
    await sendCompanyCommand({ type: 'company.responsible.remove', companyId: 'c1', personId: 'u1' }, TODAY)
    expect(del).toHaveBeenCalledWith('/companies/c1/responsibles/u1')
    expect(post).toHaveBeenCalledWith('/projects/p1/members', { remove: ['u1'] })
    expect(post).toHaveBeenCalledTimes(1)
  })
})

describe('projects', () => {
  const clientProject: ClientProject = { id: 'tmp-p', name: 'Portal', desc: 'd', state: 'planned', pct: 0, due: '', team: ['u1'], epics: [] }
  const internal: InternalProject = { id: 'tmp-i', name: 'Infra', desc: '', area: 'Ops', state: 'active', pct: 0, due: '', team: [] }

  it('creates a client project and returns its backend id', async () => {
    post.mockResolvedValueOnce({ id: 'p1' })
    const r = await sendCompanyCommand({ type: 'company.project.create', companyId: 'c1', project: clientProject }, TODAY)
    expect(post).toHaveBeenCalledWith('/projects', expect.objectContaining({ name: 'Portal', status: 'planned', company_id: 'c1', start_date: TODAY, end_date: null }))
    expect(r).toEqual({ id: 'p1' })
  })

  it('creates an internal project and returns its backend id', async () => {
    post.mockResolvedValueOnce({ id: 'i1' })
    const r = await sendCompanyCommand({ type: 'project.internal.create', project: internal }, TODAY)
    expect(post).toHaveBeenCalledWith('/projects', expect.objectContaining({ name: 'Infra', area: 'Ops', company_id: null }))
    expect(r).toEqual({ id: 'i1' })
  })

  it('moves client and internal projects between states', async () => {
    patch.mockResolvedValue({})
    await sendCompanyCommand({ type: 'project.client.setState', companyId: 'c1', id: 'p1', state: 'maint' }, TODAY)
    await sendCompanyCommand({ type: 'project.internal.setState', id: 'i1', state: 'hold' }, TODAY)
    expect(patch).toHaveBeenCalledWith('/projects/p1', { status: 'maintenance' })
    expect(patch).toHaveBeenCalledWith('/projects/i1', { status: 'on_hold' })
  })
})

describe('randomPassword', () => {
  it('draws again instead of folding a value from the uneven top of the range (no modulo bias)', () => {
    // For n = 3, 2^32 is not a multiple of 3: 0xFFFFFFFF is in the uneven tail and must be drawn again.
    const queue = [0xffffffff, 4]
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      ;(a as unknown as Uint32Array)[0] = queue.shift() ?? 0
      return a
    })
    const i = randomIndex(3)
    spy.mockRestore()
    expect(i).toBe(1) // 4 % 3; a biased picker would have returned 0xFFFFFFFF % 3 = 0
  })

  it('has the asked length with an upper, a lower, a digit and a symbol, and differs each time', () => {
    const a = randomPassword(12)
    expect(a).toHaveLength(12)
    expect(a).toMatch(/[A-Z]/)
    expect(a).toMatch(/[a-z]/)
    expect(a).toMatch(/[0-9]/)
    expect(a).toMatch(/[^A-Za-z0-9]/)
    expect(randomPassword(12)).not.toBe(a)
  })
})
