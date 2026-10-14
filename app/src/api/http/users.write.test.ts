import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Person, Session } from '../types'

const { get, post, patch, put, del, liveProjects, session } = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  liveProjects: vi.fn(),
  session: { current: null as Session | null },
}))
vi.mock('./client', async importOriginal => ({ ...(await importOriginal<typeof import('./client')>()), api: { get, post, patch, put, delete: del } }))
vi.mock('./companies', async importOriginal => ({ ...(await importOriginal<typeof import('./companies')>()), liveProjects }))
vi.mock('../session/store', () => ({ readSession: () => session.current }))

const { isUserApiCommand, sendUserCommand } = await import('./users')

const admin: Session = { personId: 'a0', name: 'Vilje Admin', email: 'admin@x', role: 'super', org: 'Viljetech' }
const me: Session = { personId: 'u1', name: 'Rahul', email: 'rahul@x', role: 'dev', org: 'Viljetech' }

const backendUser = (extra: Record<string, unknown> = {}) => ({
  id: 'u9',
  full_name: 'Kari Berg',
  email: 'kari@x',
  role: 'employee',
  role_keys: ['employee'],
  role_ids: ['r-emp'],
  status: 'active',
  timezone: 'UTC',
  phone: null,
  last_login_at: null,
  internal_profile: { employment_type: 'staff', dev_type: 'Backend' },
  profile_photo_url: null,
  ...extra,
})

const person = (over: Partial<Person> = {}): Person => ({
  id: 'u9',
  name: 'Kari Berg',
  email: 'kari@x',
  org: 'vt',
  role: 'dev',
  devType: 'Backend',
  emp: 'employee',
  projects: ['p1'],
  colour: '#000',
  active: true,
  last: 'Never',
  photo: '',
  ...over,
})

beforeEach(() => {
  for (const m of [get, post, patch, put, del, liveProjects]) m.mockReset()
  put.mockResolvedValue({})
  session.current = admin
  liveProjects.mockResolvedValue([
    { id: 'p1', member_ids: ['u9'] },
    { id: 'p2', member_ids: [] },
  ])
  get.mockImplementation(async (path: string) => {
    if (path === '/users/u9') return backendUser()
    if (path === '/settings/public') return { password_policy: { min_length: 10, max_length: 12 } }
    if (path.startsWith('/roles')) return [
      { id: 'r-emp', key: 'employee' },
      { id: 'r-dev', key: 'devops' },
      { id: 'r-mgr', key: 'manager' },
    ]
    if (path === '/app-access') return { perms: null, dev_types: null }
    if (path.startsWith('/companies')) return []
    throw new Error(`unexpected ${path}`)
  })
  post.mockResolvedValue({ id: 'u9' })
  patch.mockResolvedValue({})
  del.mockResolvedValue({})
})

describe('isUserApiCommand', () => {
  it('takes user, access and profile commands', () => {
    for (const type of ['user.create', 'user.update', 'user.remove', 'access.setPerm', 'access.addDevType', 'profile.update'])
      expect(isUserApiCommand({ type })).toBe(true)
    expect(isUserApiCommand({ type: 'leave.create' })).toBe(false)
  })
})

describe('user.create', () => {
  it('adds a staff member with a random password and emails them a link to set their own', async () => {
    const out = await sendUserCommand({ type: 'user.create', person: person({ id: 'tmp', projects: ['p2'] }) })
    expect(out).toEqual({ id: 'u9' })
    const [path, body] = post.mock.calls[0]
    expect(path).toBe('/users')
    expect(body).toMatchObject({ email: 'kari@x', full_name: 'Kari Berg', role: 'employee', internal_profile: { employment_type: 'staff', dev_type: 'Backend' } })
    expect(body.initial_password).toHaveLength(12)
    expect(post).toHaveBeenCalledWith('/users/u9/reset-password', {})
    expect(post).toHaveBeenCalledWith('/projects/p2/members', { add: ['u9'] })
  })

  it('keeps the person when a later step fails, and says which steps did not save', async () => {
    post.mockImplementation(async (path: string) => {
      if (path === '/users') return { id: 'u9' }
      if (path.endsWith('/members')) throw new Error('down')
      return {}
    })
    const out = await sendUserCommand({ type: 'user.create', person: person({ id: 'tmp', projects: ['p2'] }) })
    expect(out).toEqual({ id: 'u9', notice: 'Kari Berg was added, but their projects did not save. Edit them to try again.' })
  })

  it('adds a DevOps engineer as staff holding the devops role', async () => {
    await sendUserCommand({ type: 'user.create', person: person({ id: 'tmp', role: 'devops', projects: 'all' }) })
    expect(post.mock.calls[0][1]).toMatchObject({ role: 'employee' })
    expect(patch).toHaveBeenCalledWith('/users/u9/roles', { role_ids: ['r-emp', 'r-dev'] })
  })

  it('adds a client person to their company as a contact', async () => {
    await sendUserCommand({ type: 'user.create', person: person({ id: 'tmp', role: 'cuser', org: 'c1', projects: 'all' }) })
    expect(post.mock.calls[0][0]).toBe('/companies/c1/representatives')
  })

  it('refuses the app\'s separate Admin role, which the backend does not have', async () => {
    await expect(sendUserCommand({ type: 'user.create', person: person({ role: 'admin' }) })).rejects.toMatchObject({ status: 403 })
    expect(post).not.toHaveBeenCalled()
  })
})

describe('user.update', () => {
  it("sets a client user's projects on the projects' client lists, within their company", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/users/k2') return backendUser({ id: 'k2', role: 'representative', role_keys: ['representative'], client_profile: { company_id: 'c1' }, internal_profile: undefined })
      throw new Error(`unexpected ${path}`)
    })
    liveProjects.mockResolvedValue([
      { id: 'p1', company_id: 'c1', member_ids: [], representative_ids: ['k2'] },
      { id: 'p2', company_id: 'c1', member_ids: [], representative_ids: [] },
      { id: 'p3', company_id: 'c2', member_ids: [], representative_ids: ['k2'] },
    ])
    await sendUserCommand({ type: 'user.update', id: 'k2', patch: { projects: ['p2'] } })
    expect(post.mock.calls).toEqual([
      ['/projects/p1/representatives', { remove: ['k2'] }],
      ['/projects/p2/representatives', { add: ['k2'] }],
    ])
  })

  it('sends only what changed', async () => {
    await sendUserCommand({ type: 'user.update', id: 'u9', patch: person({ name: 'Kari B', devType: 'Mobile' }) })
    expect(patch).toHaveBeenCalledWith('/users/u9', { full_name: 'Kari B', internal_profile: { dev_type: 'Mobile' } })
    expect(post).not.toHaveBeenCalled()
  })

  it('turns DevOps on and off without touching the person\'s other roles', async () => {
    get.mockImplementation(async (path: string) => {
      if (path === '/users/u9') return backendUser({ role_ids: ['r-emp', 'r-other'] })
      if (path.startsWith('/roles')) return [{ id: 'r-emp', key: 'employee' }, { id: 'r-dev', key: 'devops' }]
      return []
    })
    await sendUserCommand({ type: 'user.update', id: 'u9', patch: person({ role: 'devops' }) })
    expect(patch).toHaveBeenCalledWith('/users/u9/roles', { role_ids: ['r-emp', 'r-other', 'r-dev'] })
    patch.mockClear()
    get.mockImplementation(async (path: string) => {
      if (path === '/users/u9') return backendUser({ role_ids: ['r-emp', 'r-dev', 'r-other'], role_keys: ['employee', 'devops', 'other'] })
      if (path.startsWith('/roles')) return [{ id: 'r-emp', key: 'employee' }, { id: 'r-dev', key: 'devops' }]
      return []
    })
    await sendUserCommand({ type: 'user.update', id: 'u9', patch: person({ role: 'dev' }) })
    expect(patch).toHaveBeenCalledWith('/users/u9/roles', { role_ids: ['r-emp', 'r-other'] })
  })

  it('never touches projects of an archived company the form does not show', async () => {
    liveProjects.mockResolvedValueOnce([
      { id: 'p1', member_ids: ['u9'], company_id: 'c1' },
      { id: 'p9', member_ids: ['u9'], company_id: 'c-old' },
    ])
    get.mockImplementation(async (path: string) => {
      if (path === '/users/u9') return backendUser()
      if (path.startsWith('/companies')) return [{ id: 'c1', status: 'active' }, { id: 'c-old', status: 'archived' }]
      return []
    })
    await sendUserCommand({ type: 'user.update', id: 'u9', patch: person({ projects: [] }) })
    expect(post).toHaveBeenCalledWith('/projects/p1/members', { remove: ['u9'] })
    expect(post).not.toHaveBeenCalledWith('/projects/p9/members', expect.anything())
  })

  it('changes the role, and turns the DevOps role on', async () => {
    await sendUserCommand({ type: 'user.update', id: 'u9', patch: person({ role: 'devops' }) })
    expect(post).not.toHaveBeenCalledWith('/users/u9/change-role', expect.anything())
    expect(patch).toHaveBeenCalledWith('/users/u9/roles', { role_ids: ['r-emp', 'r-dev'] })
  })

  it('makes someone a project manager', async () => {
    await sendUserCommand({ type: 'user.update', id: 'u9', patch: person({ role: 'pm' }) })
    expect(post).toHaveBeenCalledWith('/users/u9/change-role', { new_role: 'manager' })
  })

  it('refuses moving someone between staff and client', async () => {
    await expect(sendUserCommand({ type: 'user.update', id: 'u9', patch: person({ role: 'cuser', org: 'c1' }) })).rejects.toMatchObject({ status: 403 })
    expect(patch).not.toHaveBeenCalled()
  })

  it('deactivates and reactivates', async () => {
    await sendUserCommand({ type: 'user.update', id: 'u9', patch: person({ active: false }) })
    expect(post).toHaveBeenCalledWith('/users/u9/deactivate', {})
    get.mockImplementation(async (path: string) => (path === '/users/u9' ? backendUser({ status: 'deactivated' }) : []))
    await sendUserCommand({ type: 'user.update', id: 'u9', patch: person({ active: true }) })
    expect(post).toHaveBeenCalledWith('/users/u9/reactivate', {})
  })

  it('updates project access by membership', async () => {
    await sendUserCommand({ type: 'user.update', id: 'u9', patch: person({ projects: ['p2'] }) })
    expect(post).toHaveBeenCalledWith('/projects/p1/members', { remove: ['u9'] })
    expect(post).toHaveBeenCalledWith('/projects/p2/members', { add: ['u9'] })
  })

  it('removes a photo', async () => {
    get.mockImplementation(async (path: string) => (path === '/users/u9' ? backendUser({ profile_photo_url: 'https://x/p.jpg' }) : []))
    await sendUserCommand({ type: 'user.update', id: 'u9', patch: person({ photo: '' }) })
    expect(del).toHaveBeenCalledWith('/users/u9/profile-photo')
  })
})

describe('user.remove', () => {
  it('deactivates (the backend keeps people)', async () => {
    await sendUserCommand({ type: 'user.remove', id: 'u9' })
    expect(post).toHaveBeenCalledWith('/users/u9/deactivate', {})
  })
})

describe('access', () => {
  it('saves one role\'s ticks', async () => {
    await sendUserCommand({ type: 'access.setPerm', role: 'dev', perm: 'ts.all', on: true })
    const [path, body] = put.mock.calls[0]
    expect(path).toBe('/app-access')
    expect(Object.keys(body.perms)).toEqual(['dev'])
    expect(body.perms.dev).toContain('ts.all')
  })

  it('never changes the super admin column', async () => {
    await expect(sendUserCommand({ type: 'access.setPerm', role: 'super', perm: 'ts.all', on: false })).rejects.toMatchObject({ status: 403 })
    expect(put).not.toHaveBeenCalled()
  })

  it('adds a developer type once', async () => {
    await sendUserCommand({ type: 'access.addDevType', name: 'Data' })
    expect(put.mock.calls[0][1].dev_types).toContain('Data')
    await sendUserCommand({ type: 'access.addDevType', name: 'Backend' })
    expect(put).toHaveBeenCalledTimes(1)
  })
})

describe('profile.update', () => {
  beforeEach(() => {
    session.current = me
  })

  it('saves name, phone and time zone for the signed-in person', async () => {
    await sendUserCommand({ type: 'profile.update', id: 'u1', patch: { name: 'Rahul K', phone: '+4790000000', tz: 'Europe/Oslo' } })
    expect(patch).toHaveBeenCalledWith('/users/u1', { full_name: 'Rahul K', phone: '+4790000000', timezone: 'Europe/Oslo' })
  })

  it('emails a link for a new password (the backend needs the current one to change it here)', async () => {
    await expect(sendUserCommand({ type: 'profile.update', id: 'u1', patch: { name: 'Rahul', pwHash: 'abc' } })).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/emailed you/),
    })
    expect(patch).toHaveBeenCalledWith('/users/u1', { full_name: 'Rahul' })
    expect(post).toHaveBeenCalledWith('/auth/forgot-password', { email: 'rahul@x' })
    // Marked as saved, so the window keeps the new details.
    await sendUserCommand({ type: 'profile.update', id: 'u1', patch: { pwHash: 'abc' } }).catch(e => expect(e.code).toBe('SAVED_WITH_NOTICE'))
  })

  it('refuses changing someone else\'s profile here', async () => {
    await expect(sendUserCommand({ type: 'profile.update', id: 'u7', patch: { name: 'X' } })).rejects.toMatchObject({ status: 403 })
  })
})
