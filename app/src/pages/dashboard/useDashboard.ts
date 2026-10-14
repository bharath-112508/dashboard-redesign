import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fetchProjectHours } from '../../api/http/timesheet'
import { useCompanies, useDevops, useEntries, useInternalProjects, useLeave, useQuestions, useRequests, useTasks, useWorkspace } from '../../api/queries'
import { apiMode } from '../../api/http/config'
import { usePeople } from '../../api/people/directory'
import { buildDashboard, type Dashboard } from '../../api/dashboard/model'
import { todayIso } from '../../api/dashboard/time'
import type { Session } from '../../api/types'

/**
 * Reads every store the Dashboard uses and builds the page content for the
 * signed-in person. `model` is null until all of them have loaded.
 */
export const useDashboard = (me: Session) => {
  const people = usePeople()
  const companies = useCompanies()
  const tasks = useTasks()
  const entries = useEntries()
  const questions = useQuestions()
  const workspace = useWorkspace()
  const devops = useDevops()
  const requests = useRequests()
  const internal = useInternalProjects()
  const leave = useLeave()
  // API mode: all-time hours per project for the budgets (team readers only: super admin, admin, project manager).
  const projectHours = useQuery({
    queryKey: ['projectHours'],
    queryFn: fetchProjectHours,
    enabled: apiMode && (me.role === 'super' || me.role === 'admin' || me.role === 'pm'),
  })

  const ready =
    people.data !== undefined &&
    companies.data !== undefined &&
    tasks.data !== undefined &&
    entries.data !== undefined &&
    questions.data !== undefined &&
    workspace.data !== undefined &&
    devops.data !== undefined &&
    requests.data !== undefined &&
    internal.data !== undefined &&
    // A failed leave read leaves two widgets empty, not the whole page loading.
    (leave.data !== undefined || leave.isError)

  const model: Dashboard | null = useMemo(() => {
    if (!ready) return null
    return buildDashboard(
      {
        tasks: tasks.data ?? [],
        entries: entries.data ?? [],
        questions: questions.data ?? [],
        companies: companies.data ?? [],
        people: people.data ?? [],
        workspace: workspace.data!,
        devops: devops.data!,
        requests: requests.data ?? [],
        leave: leave.data ?? [],
        hoursByProject: projectHours.data,
        live: apiMode,
      },
      me,
      todayIso(),
    )
    // Each store is replaced as a whole when it changes, so its reference is the dependency.
  }, [ready, me, people.data, companies.data, tasks.data, entries.data, questions.data, workspace.data, devops.data, requests.data, leave.data, projectHours.data])

  return {
    ready,
    model,
    people: people.data ?? [],
    companies: companies.data ?? [],
    internal: internal.data ?? [],
    tasks: tasks.data ?? [],
    statuses: workspace.data?.statuses ?? [],
    entries: entries.data ?? [],
    today: todayIso(),
  }
}
