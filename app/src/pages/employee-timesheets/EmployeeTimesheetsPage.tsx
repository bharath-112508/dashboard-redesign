import { useSearchParams } from 'react-router'
import { PageHead, Tabs } from '../users/ui'
import { UsersTab } from '../users/UsersTab'
import { RolesTab } from '../users/RolesTab'
import { useSession } from '../../api/session/store'
import { canEditPeople } from '../../api/users/access'
import { TimesheetsTab } from './TimesheetsTab'

type Section = 'users' | 'timesheets' | 'roles'

/** Employee timesheets (route /employee-timesheets): Users, Timesheets and Roles & permissions. */
export function EmployeeTimesheetsPage() {
  const session = useSession()
  const [params, setParams] = useSearchParams()
  if (!session) return null

  const raw = params.get('tab')
  const section: Section = raw === 'users' || raw === 'roles' ? raw : 'timesheets'
  const canEdit = canEditPeople(session.role)
  return (
    <main className="px-7 pb-14 pt-4">
      <PageHead title="Employee timesheets" subtitle="All projects and employees" />
      <div className="mt-5">
        <Tabs<Section>
          name="Employee timesheet sections"
          value={section}
          items={[
            { id: 'users', label: 'Users' },
            { id: 'timesheets', label: 'Timesheets' },
            { id: 'roles', label: 'Roles & permissions' },
          ]}
          onChange={id => setParams(id === 'timesheets' ? {} : { tab: id })}
        />
      </div>
      <div role="tabpanel" className="mt-5">
        {section === 'users' && <UsersTab scope="all" canEdit={canEdit} profileBase="employee-timesheets" session={session} />}
        {section === 'timesheets' && <TimesheetsTab />}
        {section === 'roles' && <RolesTab canEdit={canEdit} />}
      </div>
    </main>
  )
}
