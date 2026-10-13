import { ApiError, api } from './client'
import { allPages, createContact, liveProjects, passwordLength, randomPassword } from './companies'
import { personFromUser, type BackendUser } from './mappers'
import { DEFAULT_DEV_TYPES, DEFAULT_PERMS } from '../users/access'
import { readSession } from '../session/store'
import type { ProfilePatch } from '../commands'
import type { UsersCommand } from '../users/commands'
import type { AccessConfig, Person, PersonId, Role, Session } from '../types'

/** The person a session describes, for client users who may not list anyone. */
const selfOf = (s: Session): Person => ({
  id: s.personId,
  name: s.name,
  email: s.email,
  org: s.orgId ?? 'vt',
  role: s.role,
  projects: 'all',
  colour: '#4870E8',
  active: true,
  last: 'Now',
  photo: '',
})

/** Backend roles that see every project. */
const SEES_ALL = new Set(['admin', 'manager'])

/**
 * The people directory. Staff list the backend's users (an admin also the
 * deactivated ones), with each person's projects from project membership.
 * A client admin sees their company's contacts; a client user only themselves.
 */
export const fetchPeopleApi = async (session: Session | null): Promise<Person[]> => {
  if (!session) return []
  if (session.role === 'cuser') return [selfOf(session)]
  if (session.role === 'cadmin') {
    if (!session.orgId) return [selfOf(session)]
    const contacts = await allPages<BackendUser>(`/companies/${session.orgId}/representatives`)
    const people = contacts.map(u => ({ ...personFromUser(u), org: session.orgId as string }))
    return people.some(p => p.id === session.personId) ? people : [selfOf(session), ...people]
  }
  const [users, projects] = await Promise.all([
    allPages<BackendUser>(session.role === 'super' ? '/users?show_deleted=true' : '/users'),
    liveProjects(),
  ])
  return users.map(u => {
    const p = personFromUser(u)
    return SEES_ALL.has(u.role) ? p : { ...p, projects: projects.filter(x => x.member_ids?.includes(u.id)).map(x => x.id) }
  })
}

/** The Roles & permissions grid and developer types: what was saved, else the design's defaults. */
export const fetchAccessApi = async (): Promise<AccessConfig> => {
  const stored = await api.get<{ perms: Partial<Record<Role, string[]>> | null; dev_types: string[] | null }>('/app-access')
  return {
    perms: { ...DEFAULT_PERMS, ...(stored.perms ?? {}) },
    devTypes: stored.dev_types ?? DEFAULT_DEV_TYPES,
  }
}

// ─── Writes ──────────────────────────────────────────────────────────────

type UserApiCommand = UsersCommand | { type: 'profile.update'; id: PersonId; patch: ProfilePatch }
const USER_COMMANDS = new Set(['user.create', 'user.update', 'user.remove', 'access.setPerm', 'access.addDevType', 'profile.update'])
export const isUserApiCommand = (cmd: { type: string }): cmd is UserApiCommand => USER_COMMANDS.has(cmd.type)

const refuse = (message: string) => new ApiError(403, 'FORBIDDEN', message)

/** The backend's system role for an app role (the current one wins where two backend roles share an app role). */
const backendRoleOf = (role: Role, current?: string): string => {
  switch (role) {
    case 'super':
      return 'admin'
    case 'pm':
      return current === 'team_lead' ? 'team_lead' : 'manager'
    case 'dev':
    case 'devops':
      return 'employee'
    case 'cadmin':
      return 'client'
    case 'cuser':
      return 'representative'
    case 'admin':
      throw refuse('The backend has no separate Admin role. Choose Super admin or Project manager.')
  }
}
const CLIENT_SIDE = new Set(['client', 'representative'])

/** Sets whether a staff member holds the custom devops role, keeping their system role. */
const setDevops = async (id: string, systemRole: string, on: boolean) => {
  const roles = await api.get<{ id: string; key: string }[]>('/roles')
  const idOf = (key: string) => roles.find(r => r.key === key)?.id
  const base = idOf(systemRole)
  const devops = idOf('devops')
  if (!base || (on && !devops)) throw refuse('The DevOps role is not set up on the backend yet.')
  await api.patch(`/users/${id}/roles`, { role_ids: on ? [base, devops] : [base] })
}

/** Adds and removes the person on project member lists so they match `projects` ('all' changes nothing). */
const syncProjects = async (id: string, projects: Person['projects']) => {
  if (projects === 'all') return
  const all = await liveProjects()
  const wants = new Set(projects)
  for (const p of all) {
    const has = (p.member_ids ?? []).includes(id)
    if (has && !wants.has(p.id)) await api.post(`/projects/${p.id}/members`, { remove: [id] })
    if (!has && wants.has(p.id)) await api.post(`/projects/${p.id}/members`, { add: [id] })
  }
}

type UploadTicket = { upload_url: string; blob_container: string; blob_key: string; required_headers: Record<string, string> }

/** A new photo (a data URL from the form) is uploaded; '' removes the current one. */
const savePhoto = async (id: string, photo: string | undefined, current: string | null | undefined) => {
  if (photo === '' && current) return void (await api.delete(`/users/${id}/profile-photo`))
  if (!photo?.startsWith('data:')) return
  const blob = await (await fetch(photo)).blob()
  const meta = { file_name: `photo.${(blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`, file_size: blob.size, mime_type: blob.type || 'image/png' }
  const t = await api.post<UploadTicket>(`/users/${id}/profile-photo-upload-url`, meta)
  const res = await fetch(t.upload_url, { method: 'PUT', headers: t.required_headers, body: blob }).catch(() => null)
  if (!res?.ok) throw refuse('The photo could not be uploaded. Try again.')
  await api.post(`/users/${id}/profile-photo`, { blob_container: t.blob_container, blob_key: t.blob_key, ...meta })
}

const createUser = async (p: Person): Promise<string> => {
  const role = backendRoleOf(p.role)
  if (CLIENT_SIDE.has(role)) {
    if (p.org === 'vt') throw refuse('A client person needs their company.')
    return createContact(p.org, { personId: null, name: p.name, email: p.email, role: '', admin: role === 'client', projects: Array.isArray(p.projects) ? p.projects : [] })
  }
  const { id } = await api.post<{ id: string }>('/users', {
    email: p.email,
    full_name: p.name,
    role,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    // They choose their own password from the emailed link; nobody sees this one.
    initial_password: randomPassword(await passwordLength()),
    internal_profile: { employment_type: p.emp === 'freelancer' ? 'freelancer' : 'staff', ...(p.devType ? { dev_type: p.devType } : {}) },
  })
  await api.post(`/users/${id}/reset-password`, {})
  if (p.role === 'devops') await setDevops(id, role, true)
  await syncProjects(id, p.projects)
  await savePhoto(id, p.photo, null)
  return id
}

const updateUser = async (id: string, patch: Partial<Person>) => {
  const before = await api.get<BackendUser>(`/users/${id}`)
  const target = patch.role ? backendRoleOf(patch.role, before.role) : before.role
  // Checked before any write, so nothing is left half-done.
  if (CLIENT_SIDE.has(target) !== CLIENT_SIDE.has(before.role))
    throw refuse('Someone cannot move between staff and client. Deactivate them and add them again.')
  const body: Record<string, unknown> = {}
  if (patch.name !== undefined && patch.name !== before.full_name) body.full_name = patch.name
  if (patch.email !== undefined && patch.email !== before.email) body.email = patch.email
  if (patch.phone !== undefined && (patch.phone || null) !== (before.phone ?? null)) body.phone = patch.phone || null
  if (!CLIENT_SIDE.has(target)) {
    const ip: Record<string, unknown> = {}
    if ('devType' in patch && (patch.devType ?? null) !== (before.internal_profile?.dev_type ?? null)) ip.dev_type = patch.devType ?? null
    const emp = patch.emp === 'freelancer' ? 'freelancer' : patch.emp === 'employee' ? 'staff' : undefined
    if (emp && emp !== (before.internal_profile?.employment_type ?? 'staff')) ip.employment_type = emp
    if (Object.keys(ip).length) body.internal_profile = ip
  }
  if (Object.keys(body).length) await api.patch(`/users/${id}`, body)
  if (target !== before.role) await api.post(`/users/${id}/change-role`, { new_role: target })
  if (patch.role && !CLIENT_SIDE.has(target)) {
    const has = (before.role_keys ?? []).includes('devops')
    const wants = patch.role === 'devops'
    if (has !== wants || (wants && target !== before.role)) await setDevops(id, target, wants)
  }
  if (patch.active !== undefined && patch.active !== (before.status === 'active'))
    await api.post(`/users/${id}/${patch.active ? 'reactivate' : 'deactivate'}`, {})
  if (patch.projects !== undefined && !CLIENT_SIDE.has(target)) await syncProjects(id, patch.projects)
  if ('photo' in patch) await savePhoto(id, patch.photo, before.profile_photo_url)
}

const saveAccess = async (body: { perms?: Partial<Record<Role, string[]>>; dev_types?: string[] }) => {
  await api.put('/app-access', body)
}

/** Sends one users, access or profile command to the backend. */
export const sendUserCommand = async (cmd: UserApiCommand): Promise<{ id?: string }> => {
  switch (cmd.type) {
    case 'user.create':
      return { id: await createUser(cmd.person) }
    case 'user.update':
      await updateUser(cmd.id, cmd.patch)
      return {}
    case 'user.remove':
      // The backend keeps people (their time and tickets point at them): removing deactivates.
      await api.post(`/users/${cmd.id}/deactivate`, {})
      return {}
    case 'access.setPerm': {
      if (cmd.role === 'super') throw refuse('The super admin always holds every permission.')
      const now = (await fetchAccessApi()).perms[cmd.role] ?? []
      const next = cmd.on ? [...new Set([...now, cmd.perm])] : now.filter(p => p !== cmd.perm)
      await saveAccess({ perms: { [cmd.role]: next } })
      return {}
    }
    case 'access.addDevType': {
      const types = (await fetchAccessApi()).devTypes
      if (types.some(t => t.toLowerCase() === cmd.name.trim().toLowerCase())) return {}
      await saveAccess({ dev_types: [...types, cmd.name.trim()] })
      return {}
    }
    case 'profile.update': {
      const s = readSession()
      if (!s || cmd.id !== s.personId) throw refuse('You can only change your own profile here.')
      const p = cmd.patch
      const body: Record<string, unknown> = {}
      if (p.name !== undefined) body.full_name = p.name
      if (p.phone !== undefined) body.phone = p.phone || null
      if (p.tz !== undefined) body.timezone = p.tz
      if (Object.keys(body).length) await api.patch(`/users/${s.personId}`, body)
      // ponytail: the four notification toggles live in the session only (no backend field yet).
      if (p.pwHash) {
        // The backend changes a password only with the current one, which this window does not ask for.
        await api.post('/auth/forgot-password', { email: s.email })
        throw refuse('Your details are saved. To set the new password, open the link we have emailed you.')
      }
      return {}
    }
    default:
      return {}
  }
}
