import { useSearchParams } from 'react-router'
import { useSession } from '../../api/session/store'
import { canEditPeople } from '../../api/users/access'
import { PageHead, Tabs } from './ui'
import { UsersTab } from './UsersTab'
import { RolesTab } from './RolesTab'

type Section = 'users' | 'roles'

/** Users (route /users). Client admins see their own company as "Colleagues". */
export function UsersPage() {
  const session = useSession()
  const [params, setParams] = useSearchParams()
  if (!session) return null

  if (session.role === 'cadmin') {
    return (
      <main className="px-7 pb-14 pt-4">
        <PageHead title="Colleagues" subtitle="Users & permissions" />
        <div className="mt-5">
          <UsersTab scope="colleagues" canEdit session={session} />
        </div>
      </main>
    )
  }

  const section: Section = params.get('tab') === 'roles' ? 'roles' : 'users'
  const canEdit = canEditPeople(session.role)
  return (
    <main className="px-7 pb-14 pt-4">
      <PageHead title="Users" subtitle="Workspace settings" />
      <div className="mt-5">
        <Tabs<Section>
          name="Users sections"
          value={section}
          items={[
            { id: 'users', label: 'Users' },
            { id: 'roles', label: 'Roles & permissions' },
          ]}
          onChange={id => setParams(id === 'users' ? {} : { tab: id })}
        />
      </div>
      <div role="tabpanel" className="mt-5">
        {section === 'users' ? (
          <UsersTab scope="all" canEdit={canEdit} profileBase="users" session={session} />
        ) : (
          <RolesTab canEdit={canEdit} />
        )}
      </div>
    </main>
  )
}
