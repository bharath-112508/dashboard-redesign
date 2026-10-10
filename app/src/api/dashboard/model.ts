import type { DevopsDb } from '../devops/types'
import type { Company, DevopsRequest, Person, Priority, Question, Role, Session, Task, TimeEntry, Workspace } from '../types'
import { activeSprint, assigneesOf, estimateHours, loggedHours, statusOf, taskKey } from '../../domain/tasks'
import { addDays, diff, short } from '../../lib/dates'
import { isClientRole } from '../session/access'
import { APPROVALS, BUDGETS, LEAVE_ATTENDANCE, type StaticListRow } from './static'
import { DAY_HOURS, WEEK_HOURS, dayLabel, dayMonth, dueLabel, hm, isWeekday, longDate, monthToDate, pctOf, weekOf, weekdaysIn } from './time'

/**
 * The Dashboard's content for one signed-in person. Pure: it takes the stores
 * and the session and returns what the page draws, so the rules can be read
 * apart from React. Figures come from the shared stores; the few that have no
 * store in this build are in ./static.ts.
 */

export type Tone = 'blue' | 'red' | 'amber' | 'grey' | 'green' | 'violet'

export const TONE: Record<Tone, { bg: string; ink: string }> = {
  blue: { bg: '#E7EEFB', ink: '#1F3FAF' },
  red: { bg: '#FBE3DF', ink: '#C0392B' },
  amber: { bg: '#FBEDC2', ink: '#7A5C0E' },
  grey: { bg: '#EEF3FB', ink: '#3B4A5E' },
  green: { bg: '#D6E9E2', ink: '#195040' },
  violet: { bg: '#F3F0FC', ink: '#3F2E94' },
}

/** The app's own routes that the widgets link to. */
export const ROUTE = {
  projects: '/projects',
  tickets: '/tickets/board',
  timesheet: '/timesheet',
  employee: '/employee-timesheets',
  devops: '/devops/board',
  users: '/users',
  clients: '/clients/board',
} as const

export type IconName = 'tix' | 'sprint' | 'clock' | 'ops' | 'q' | 'cal' | 'coin' | 'bug' | 'team' | 'ship'

export const ICON_PATH: Record<IconName, string> = {
  tix: 'M4 7h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4z',
  sprint: 'M4 12a8 8 0 1 0 8-8M4 4v4h4',
  clock: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  ops: 'M5 12h14M12 5v14M5 5h4v4H5zM15 15h4v4h-4z',
  q: 'M9 9a3 3 0 1 1 4 2.8c-.7.3-1 .9-1 1.7M12 17h.01',
  cal: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  coin: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 9h4.5a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3H15M12 7v10',
  bug: 'M8 9h8v7a4 4 0 0 1-8 0zM12 9V6M5 13h3M16 13h3M6 8l2 2M18 8l-2 2',
  team: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0 0-6M22 20a6 6 0 0 0-5-6',
  ship: 'M4 15l8 5 8-5M4 10l8 5 8-5-8-5z',
}

export interface Kpi {
  id: string
  label: string
  value: string
  of: string
  sub: string
  dot: string
  valueColor?: string
  href: string
  /** Opens the drawer instead of navigating. */
  drawer?: 'critical' | 'overdue'
}

export interface ListRow {
  id: string
  tag: string
  tone: Tone
  title: string
  meta: string
  right?: string
  rightTone?: 'red' | 'amber' | 'ink'
  href: string
}

export interface ProgRow {
  id: string
  title: string
  value: string
  pct: number
  barColor: string
  valueColor: string
  meta: string
  metaColor: string
  href: string
}

export interface BarDay {
  label: string
  date: string
  billable: number
  non: number
  idle: number
}

export interface StatusRow {
  id: string
  title: string
  status: string
  tone: Tone
  /** How many of the four dots are filled. */
  steps: number
  href: string
}

export type WidgetBody =
  | { kind: 'list'; rows: ListRow[]; empty: string }
  | { kind: 'prog'; rows: ProgRow[]; empty: string }
  | { kind: 'bars'; days: BarDay[]; foot: string; idle: boolean }
  | { kind: 'status'; rows: StatusRow[]; empty: string }

export interface Widget {
  id: string
  title: string
  sub: string
  link: string
  href: string
  icon: IconName
  body: WidgetBody
}

export interface DrawerRow {
  id: number
  key: string
  title: string
  prio: Priority
  project: string
  hours: string
  assignees: string[]
  status: string
  due: string
  overdue: boolean
  href: string
}

export interface Dashboard {
  greeting: string
  dateLine: string
  dayShort: string
  scope: string
  org: { label: string; client: boolean }
  kpis: Kpi[]
  widgets: Widget[]
  critical: DrawerRow[]
  overdue: DrawerRow[]
  /** Quick-log is for the people who log development and infra time. */
  canLog: boolean
}

export interface DashboardData {
  tasks: Task[]
  entries: TimeEntry[]
  questions: Question[]
  companies: Company[]
  people: Person[]
  workspace: Workspace
  devops: DevopsDb
  requests: DevopsRequest[]
}

const SCOPE: Partial<Record<Role, string>> = {
  super: 'Everything across Viljetech and all client companies',
  admin: 'Viljetech team, projects and approvals',
  pm: 'Daco and Nordlys projects you manage',
  dev: 'Your tickets and time',
  devops: 'Infra, environments and DevOps requests',
}

const DN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const PRIO_TONE: Record<Priority, Tone> = { Critical: 'red', Urgent: 'red', High: 'red', Medium: 'amber', Low: 'grey' }
/** DevOps project statuses that are not "in setup". */
const NOT_IN_SETUP = ['Not started', 'Deployment Completed']

const hoursOf = (e: TimeEntry) => e.bill + e.non
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name

/** A client question nobody has answered: not solved, no answer, no client message. */
export const isUnanswered = (q: Question) => !q.solved && !q.answer && !(q.comments || []).some(c => c.side === 'client')

/** Every ISO date from a to b inclusive (capped, so a bad date cannot loop for long). */
const datesBetween = (a: string, b: string): string[] => {
  const out: string[] = []
  for (let d = a; d <= b && out.length < 400; d = addDays(d, 1)) out.push(d)
  return out
}

/**
 * Bars per weekday. Billable and non-billable come from `entries`. Idle is the
 * day hours not logged by each person in `idlePeople` on weekdays up to today;
 * the caller leaves freelancers out of that list.
 */
const barsFor = (entries: TimeEntry[], idlePeople: { id: number }[], week: string[], today: string, withIdle: boolean): BarDay[] =>
  week.map((date, i): BarDay => {
    const day = entries.filter(e => e.date === date)
    let idle = 0
    if (withIdle && isWeekday(date) && date <= today) {
      for (const p of idlePeople) idle += Math.max(0, DAY_HOURS - sum(day.filter(e => e.userId === p.id).map(hoursOf)))
    }
    return { label: DN[i], date, billable: sum(day.map(e => e.bill)), non: sum(day.map(e => e.non)), idle }
  })

/** Idle hours of one person's entries over some dates: day hours not logged, on weekdays up to today. */
const idleOf = (entries: TimeEntry[], dates: string[], today: string) =>
  dates
    .filter(d => isWeekday(d) && d <= today)
    .reduce((a, d) => a + Math.max(0, DAY_HOURS - sum(entries.filter(e => e.date === d).map(hoursOf))), 0)

/** Static rows, with their link set to the page they belong to. */
const staticRows = (rows: StaticListRow[], href: string): ListRow[] =>
  rows.map((r, i) => ({ id: `s-${i}`, tag: r.tag, tone: r.tone, title: r.title, meta: r.meta, right: r.right, rightTone: r.rightTone, href }))

export const buildDashboard = (d: DashboardData, me: Session, today: string, now: Date = new Date()): Dashboard => {
  const hour = now.getHours()
  const week = weekOf(today)
  const weekEnd = week[6]
  const month = monthToDate(today)
  const top = d.tasks.filter(t => !t.parent)
  const open = top.filter(t => t.status !== 'done')
  const isMine = (t: Task) => assigneesOf(t).includes(me.name)
  const mine = open.filter(isMine)
  const epicName = (id: string) => d.workspace.epics.find(e => e.id === id)?.name ?? id
  const statusLabel = (id: string) => statusOf(d.workspace.statuses, id).name
  const staff = d.people.filter(p => p.org === 'vt' && p.active)
  const countable = staff.filter(p => p.emp !== 'freelancer')
  const sprintsActive = d.workspace.sprints.filter(s => s.state === 'active')
  const questionsOpen = d.questions.filter(isUnanswered)
  const isOverdue = (t: Task) => !!t.due && diff(t.due, today) < 0 && t.status !== 'done'
  const dueThisWeek = (t: Task) => !!t.due && t.due <= weekEnd && t.status !== 'done'
  const company = me.orgId ? d.companies.find(c => c.id === me.orgId) : undefined
  const companyProjects = company?.projects ?? []
  const liveProjects = companyProjects.filter(p => p.state !== 'done')
  const nextDelivery = liveProjects.map(p => p.due).filter(x => x >= today).sort()[0] ?? ''
  const clientBugs = top.filter(t => t.clientBug)
  const overdueTasks = open.filter(isOverdue).sort((a, b) => (a.due < b.due ? -1 : 1))

  const myEntries = d.entries.filter(e => e.userId === me.personId)
  const myWeek = myEntries.filter(e => week.includes(e.date))
  const myWeekHours = sum(myWeek.map(hoursOf))
  const freelancer = me.emp === 'freelancer'
  const myIdle = freelancer ? 0 : idleOf(myWeek, week, today)
  const teamWeek = d.entries.filter(e => week.includes(e.date))
  const weekPct = (h: number) => pctOf(h, WEEK_HOURS)

  const taskHref = (t: Task) => `${ROUTE.tickets}?ticket=${t.id}`
  const bugHref = (t: Task) => `${ROUTE.clients}?bug=${t.id}`
  const questionHref = (q: Question) => `${ROUTE.clients}?question=${q.id}`

  const drawerRow = (t: Task): DrawerRow => ({
    id: t.id,
    key: taskKey(t),
    title: t.title,
    prio: t.prio,
    project: epicName(t.epic),
    hours: `${hm(loggedHours(t, d.entries))}${estimateHours(t) ? ` / ${estimateHours(t)}h` : ''}`,
    assignees: assigneesOf(t),
    status: statusLabel(t.status),
    due: t.due ? dueLabel(t.due, today) : '',
    overdue: isOverdue(t),
    href: taskHref(t),
  })

  const critical = open.filter(t => t.prio === 'Critical').map(drawerRow)
  const overdue = overdueTasks.map(drawerRow)

  const statusRows = (): StatusRow[] => {
    const names = d.devops.settings.statuses.map(s => s.name)
    const last = Math.max(1, names.length - 1)
    return d.devops.projects.map((p): StatusRow => {
      const idx = Math.max(0, names.indexOf(p.infra))
      const tone: Tone = p.infra === 'Deployment Completed' ? 'green' : p.infra === 'Not started' ? 'grey' : p.overdue ? 'red' : 'blue'
      return { id: p.key, title: p.name, status: p.infra, tone, steps: Math.round((idx / last) * 4), href: ROUTE.devops }
    })
  }

  // ---- widgets used by more than one role

  const questionsWidget = (
    title = 'Client questions waiting',
    sub = 'Asked by the team, not answered yet',
    link = 'Clients',
    empty = 'All questions answered',
  ): Widget => ({
    id: 'questions',
    title,
    sub,
    link,
    href: ROUTE.clients,
    icon: 'q',
    body: {
      kind: 'list',
      empty,
      rows: questionsOpen.slice(0, 6).map((q): ListRow => ({
        id: `q-${q.id}`,
        tag: `Q-${q.id}`,
        tone: 'amber',
        title: q.title,
        meta: `Asked by ${q.by}`,
        right: q.when,
        href: questionHref(q),
      })),
    },
  })

  const devopsStatus = (): Widget => ({
    id: 'devops-status',
    title: 'DevOps status',
    sub: 'Infra steps per project',
    link: 'DevOps board',
    href: ROUTE.devops,
    icon: 'ops',
    body: { kind: 'status', empty: 'No DevOps projects yet', rows: statusRows() },
  })

  const teamBars = (): Widget => ({
    id: 'team-week',
    title: 'Team hours this week',
    sub: `${countable.length} people · 8h a day each`,
    link: 'Employee timesheets',
    href: ROUTE.employee,
    icon: 'clock',
    body: {
      kind: 'bars',
      days: barsFor(teamWeek, countable, week, today, true),
      foot: `${hm(sum(teamWeek.map(hoursOf)))} logged`,
      idle: true,
    },
  })

  const personalWeek = (): Widget => ({
    id: 'my-week',
    title: 'My week',
    sub: '8h required a day',
    link: 'Timesheet',
    href: ROUTE.timesheet,
    icon: 'clock',
    body: {
      kind: 'bars',
      days: barsFor(myWeek, [{ id: me.personId }], week, today, !freelancer),
      foot: `${hm(myWeekHours)} this week`,
      idle: !freelancer,
    },
  })

  const budgetWidget = (): Widget => ({
    id: 'budget',
    title: 'Budget vs hours used',
    sub: 'Client projects, hours sold vs logged',
    link: 'Projects',
    href: ROUTE.projects,
    icon: 'coin',
    body: {
      kind: 'prog',
      empty: 'No budgets yet',
      rows: BUDGETS.map((b, i): ProgRow => {
        const over = b.hours > b.sold
        return {
          id: `b-${i}`,
          title: b.title,
          value: `${b.hours}h / ${b.sold}h`,
          pct: Math.min(100, pctOf(b.hours, b.sold)),
          barColor: over ? '#C0392B' : '#4870E8',
          valueColor: over ? '#C0392B' : '#1B2D45',
          meta: b.meta,
          metaColor: over ? '#C0392B' : '#3B4A5E',
          href: ROUTE.projects,
        }
      }),
    },
  })

  const epicWidget = (): Widget => ({
    id: 'epics',
    title: 'Epic progress',
    sub: 'Tasks done per epic',
    link: 'Tickets',
    href: ROUTE.tickets,
    icon: 'sprint',
    body: {
      kind: 'prog',
      empty: 'No epics yet',
      rows: d.workspace.epics
        .map(ep => {
          const ts = top.filter(t => t.epic === ep.id)
          return { ep, total: ts.length, done: ts.filter(t => t.status === 'done').length }
        })
        .filter(x => x.total > 0)
        .map(({ ep, total, done }): ProgRow => {
          const s = activeSprint(d.workspace.sprints, ep.id)
          return {
            id: ep.id,
            title: ep.name,
            value: `${done} / ${total}`,
            pct: pctOf(done, total),
            barColor: '#3F9079',
            valueColor: '#1B2D45',
            meta: s ? `${s.name} · ends ${short(s.end)}` : 'No active sprint',
            metaColor: '#3B4A5E',
            href: ROUTE.tickets,
          }
        }),
    },
  })

  const overdueWidget = (): Widget => ({
    id: 'overdue',
    title: 'Overdue tickets',
    sub: 'Past due date, not done',
    link: 'Tickets',
    href: ROUTE.tickets,
    icon: 'tix',
    body: {
      kind: 'list',
      empty: 'Nothing overdue',
      rows: overdueTasks.slice(0, 6).map((t): ListRow => ({
        id: `o-${t.id}`,
        tag: t.prio === 'Critical' ? 'Critical' : taskKey(t),
        tone: t.prio === 'Critical' ? 'red' : 'blue',
        title: `${taskKey(t)} · ${t.title}`,
        meta: `${epicName(t.epic)} · ${assigneesOf(t).join(', ') || 'Unassigned'}`,
        right: dueLabel(t.due, today),
        rightTone: 'red',
        href: taskHref(t),
      })),
    },
  })

  const hoursByEmployee = (): Widget => ({
    id: 'hours-by-employee',
    title: 'Hours by employee',
    sub: 'This week, logged vs 40h',
    link: 'Employee timesheets',
    href: ROUTE.employee,
    icon: 'team',
    body: {
      kind: 'prog',
      empty: 'No people yet',
      rows: staff
        .map(p => {
          const own = teamWeek.filter(e => e.userId === p.id)
          return { p, h: sum(own.map(hoursOf)), idle: p.emp === 'freelancer' ? 0 : idleOf(own, week, today) }
        })
        .sort((a, b) => b.h - a.h)
        .slice(0, 8)
        .map(({ p, h, idle }): ProgRow => ({
          id: `e-${p.id}`,
          title: p.name,
          value: hm(h),
          pct: Math.min(100, weekPct(h)),
          barColor: '#4870E8',
          valueColor: '#1B2D45',
          meta: p.emp === 'freelancer' ? `${hm(h)} · freelancer` : `${hm(h)} · ${hm(idle)} idle`,
          metaColor: '#3B4A5E',
          href: ROUTE.employee,
        })),
    },
  })

  const sprintRows = (ss: typeof sprintsActive): ProgRow[] =>
    ss.map((s): ProgRow => {
      const ts = top.filter(t => t.sprint === s.id)
      const done = ts.filter(t => t.status === 'done').length
      const left = Math.max(0, diff(s.end, today))
      return {
        id: s.id,
        title: `${epicName(s.epic)} · ${s.name}`,
        value: `${done} / ${ts.length}`,
        pct: pctOf(done, ts.length),
        barColor: '#3F9079',
        valueColor: '#1B2D45',
        meta: `${short(s.start)} – ${short(s.end)} · ${left === 0 ? 'ends today' : `${left} days left`}`,
        metaColor: '#3B4A5E',
        href: ROUTE.tickets,
      }
    })

  const clientBugRows = (limit: number): ListRow[] =>
    clientBugs.slice(0, limit).map((t): ListRow => ({
      id: `bug-${t.id}`,
      tag: t.status === 'done' ? 'Fixed' : statusLabel(t.status),
      tone: t.status === 'done' ? 'green' : t.status === 'prog' ? 'blue' : 'grey',
      title: t.title,
      meta: `Reported ${t.clientBug?.reported ?? ''}`.trim(),
      href: bugHref(t),
    }))

  const kpi = (id: string, label: string, value: string, of: string, sub: string, dot: string, href: string, extra: Partial<Kpi> = {}): Kpi => ({
    id, label, value, of, sub, dot, href, ...extra,
  })

  // ---- one builder per role

  const superView = (): { kpis: Kpi[]; widgets: Widget[] } => {
    const liveActive = d.companies.filter(c => !c.archived).flatMap(c => c.projects).filter(p => p.state === 'active').length
    const activeCompanies = d.companies.filter(c => !c.archived).length
    const monthCap = weekdaysIn(month) * DAY_HOURS * countable.length
    const monthLogged = sum(d.entries.filter(e => month.includes(e.date) && staff.some(p => p.id === e.userId)).map(hoursOf))
    const monthIdle = countable.reduce((a, p) => a + idleOf(d.entries.filter(e => e.userId === p.id && month.includes(e.date)), month, today), 0)
    const crit = open.filter(t => t.prio === 'Critical')
    return {
      kpis: [
        kpi('active', 'Active projects', String(liveActive), '', `${activeCompanies} companies`, '#4870E8', ROUTE.projects),
        kpi('logged', 'Logged this month', hm(monthLogged), `/ ${hm(monthCap)}`, `${pctOf(monthLogged, monthCap)}% of working hours`, '#1B2D45', ROUTE.employee),
        kpi('idle', 'Idle time', hm(monthIdle), '', `${pctOf(monthIdle, monthCap)}% of working hours`, '#D9534F', ROUTE.employee),
        kpi('critical', 'Critical open', String(crit.length), '', `${crit.filter(isOverdue).length} overdue`, '#C0392B', ROUTE.tickets, { valueColor: '#C0392B', drawer: 'critical' }),
      ],
      widgets: [
        budgetWidget(),
        epicWidget(),
        teamBars(),
        devopsStatus(),
        questionsWidget(),
        {
          id: 'leave',
          title: 'Leave & attendance',
          sub: 'Today and pending approvals',
          link: 'Users',
          href: ROUTE.users,
          icon: 'cal',
          body: { kind: 'list', empty: 'Nothing waiting for you', rows: staticRows(LEAVE_ATTENDANCE, ROUTE.users) },
        },
      ],
    }
  }

  const adminView = (): { kpis: Kpi[]; widgets: Widget[] } => {
    const idle = countable.reduce((a, p) => a + idleOf(teamWeek.filter(e => e.userId === p.id), week, today), 0)
    const weekCap = countable.length * WEEK_HOURS
    const epics = new Set(overdueTasks.map(t => epicName(t.epic)))
    return {
      kpis: [
        kpi('leave', 'Pending leave', '3', '', 'Oldest from 6 Oct', '#E2B23C', ROUTE.users),
        kpi('compoff', 'Pending comp-off', '2', '', 'Weekend releases', '#E2B23C', ROUTE.users),
        kpi('idle', 'Team idle this week', hm(idle), '', `${pctOf(idle, weekCap)}% of ${weekCap}h`, '#D9534F', ROUTE.employee),
        kpi('overdue', 'Overdue tickets', String(overdueTasks.length), '', `Across ${epics.size} epics`, '#C0392B', ROUTE.tickets, { valueColor: '#C0392B', drawer: 'overdue' }),
      ],
      widgets: [
        {
          id: 'approvals',
          title: 'Approvals',
          sub: 'Leave and comp-off waiting for you',
          link: 'Users',
          href: ROUTE.users,
          icon: 'cal',
          body: { kind: 'list', empty: 'Nothing waiting for you', rows: staticRows(APPROVALS, ROUTE.users) },
        },
        hoursByEmployee(),
        overdueWidget(),
        devopsStatus(),
        teamBars(),
      ],
    }
  }

  const pmView = (): { kpis: Kpi[]; widgets: Widget[] } => {
    const first = sprintsActive[0]
    const firstTasks = first ? top.filter(t => t.sprint === first.id) : []
    const firstDone = firstTasks.filter(t => t.status === 'done').length
    const dueWeek = open.filter(dueThisWeek).sort((a, b) => (a.due < b.due ? -1 : 1))
    const dueOver = dueWeek.filter(isOverdue).length
    const availHours = first ? weekdaysIn(datesBetween(today, first.end)) * DAY_HOURS : 0
    const teamLoad = countable
      .map(p => ({ p, planned: sum(open.filter(t => assigneesOf(t).includes(p.name)).map(estimateHours)) }))
      .filter(x => x.planned > 0)
    return {
      kpis: [
        kpi('sprint-left', 'Active sprint', first ? String(Math.max(0, diff(first.end, today))) : '—', first ? 'days left' : '', first ? `${epicName(first.epic)} · ${first.name}` : 'No active sprint', '#4870E8', ROUTE.tickets),
        kpi('sprint-done', 'Sprint done', first ? `${pctOf(firstDone, firstTasks.length)}%` : '—', '', first ? `${firstDone} of ${firstTasks.length} tasks` : '', '#3F9079', ROUTE.tickets),
        kpi('due-week', 'Due this week', String(dueWeek.length), '', `${dueOver} overdue`, '#E2B23C', ROUTE.tickets),
        kpi('questions', 'Questions waiting', String(questionsOpen.length), '', questionsOpen[0] ? `Oldest ${questionsOpen[0].when}` : 'None open', '#7C5CD6', ROUTE.clients),
      ],
      widgets: [
        {
          id: 'active-sprints',
          title: 'Active sprints',
          sub: 'Tasks done vs planned',
          link: 'Epics & sprints',
          href: ROUTE.tickets,
          icon: 'sprint',
          body: { kind: 'prog', empty: 'No active sprints', rows: sprintRows(sprintsActive) },
        },
        {
          id: 'due-tickets',
          title: 'Tickets due this week',
          sub: 'Your projects',
          link: 'Tickets',
          href: ROUTE.tickets,
          icon: 'tix',
          body: {
            kind: 'list',
            empty: 'Nothing due this week',
            rows: dueWeek.slice(0, 6).map((t): ListRow => ({
              id: `d-${t.id}`,
              tag: t.prio === 'Critical' ? 'Critical' : taskKey(t),
              tone: PRIO_TONE[t.prio],
              title: t.title,
              meta: `${assigneesOf(t).join(', ') || 'Unassigned'} · ${hm(loggedHours(t, d.entries))} / ${estimateHours(t) || 0}h`,
              right: dueLabel(t.due, today),
              rightTone: isOverdue(t) ? 'red' : undefined,
              href: taskHref(t),
            })),
          },
        },
        budgetWidget(),
        questionsWidget(),
        {
          id: 'team-load',
          title: 'Team load',
          sub: 'Open estimate vs time left in sprint',
          link: 'Tickets',
          href: ROUTE.tickets,
          icon: 'team',
          body: {
            kind: 'prog',
            empty: 'No open tickets',
            rows: teamLoad.map(({ p, planned }): ProgRow => {
              const over = !!first && planned > availHours
              return {
                id: `load-${p.id}`,
                title: p.name,
                value: `${planned}h`,
                pct: first ? Math.min(100, pctOf(planned, availHours)) : 0,
                barColor: over ? '#C0392B' : '#3F9079',
                valueColor: '#1B2D45',
                meta: !first
                  ? `${planned}h planned · no active sprint`
                  : over
                    ? `${planned}h planned · ${planned - availHours}h over`
                    : `${planned}h planned · ${availHours}h available`,
                metaColor: over ? '#C0392B' : '#3B4A5E',
                href: ROUTE.tickets,
              }
            }),
          },
        },
      ],
    }
  }

  const devView = (): { kpis: Kpi[]; widgets: Widget[] } => {
    const inProgress = mine.filter(t => t.status === 'prog').length
    const dueMine = mine.filter(dueThisWeek)
    const overdueMine = dueMine.filter(isOverdue).length
    const epicIds = [...new Set(top.filter(t => isMine(t) && t.epic).map(t => t.epic))]
    const epicProgress = epicIds
      .map(id => {
        const ts = top.filter(t => t.epic === id && isMine(t))
        return { id, ts, done: ts.filter(t => t.status === 'done').length }
      })
      .filter(x => x.ts.length > 0)
      .map(({ id, ts, done }): ProgRow => ({
        id: `pe-${id}`,
        title: epicName(id),
        value: `${pctOf(done, ts.length)}% done`,
        pct: pctOf(done, ts.length),
        barColor: '#3F9079',
        valueColor: '#1B2D45',
        meta: `${ts.filter(t => t.status !== 'done').length} of my tickets open`,
        metaColor: '#3B4A5E',
        href: ROUTE.tickets,
      }))
    const sprint = sprintsActive.find(s => s.members?.includes(me.name)) ?? sprintsActive.find(s => mine.some(t => t.sprint === s.id))
    const sprintRowsMine: ProgRow[] = []
    if (sprint) {
      const ts = top.filter(t => t.sprint === sprint.id)
      const teamDone = ts.filter(t => t.status === 'done').length
      const mineIn = ts.filter(isMine)
      const mineDone = mineIn.filter(t => t.status === 'done').length
      sprintRowsMine.push(
        {
          id: 'sp-team',
          title: 'Sprint · team',
          value: `${teamDone} / ${ts.length}`,
          pct: pctOf(teamDone, ts.length),
          barColor: '#3F9079',
          valueColor: '#1B2D45',
          meta: `${teamDone} of ${ts.length} tasks done · ${Math.max(0, diff(sprint.end, today))} days left`,
          metaColor: '#3B4A5E',
          href: ROUTE.tickets,
        },
        {
          id: 'sp-mine',
          title: 'My tasks',
          value: `${mineDone} / ${mineIn.length}`,
          pct: pctOf(mineDone, mineIn.length),
          barColor: '#3F9079',
          valueColor: '#1B2D45',
          meta: `${mineDone} of ${mineIn.length} done`,
          metaColor: '#3B4A5E',
          href: ROUTE.tickets,
        },
      )
    }
    return {
      kpis: [
        kpi('open', 'My open tickets', String(mine.length), '', `${inProgress} in progress`, '#4870E8', ROUTE.tickets),
        kpi('due', 'Due this week', String(dueMine.length), '', `${overdueMine} overdue`, '#E2B23C', ROUTE.tickets),
        kpi('logged', 'Logged this week', hm(myWeekHours), freelancer ? '' : `/ ${WEEK_HOURS}h`, freelancer ? 'This week' : `${weekPct(myWeekHours)}% of working hours`, '#1B2D45', ROUTE.timesheet),
        ...(freelancer ? [] : [kpi('idle', 'Idle this week', hm(myIdle), '', `${pctOf(myIdle, WEEK_HOURS)}% of working hours`, '#D9534F', ROUTE.timesheet)]),
      ],
      widgets: [
        {
          id: 'my-tickets',
          title: 'My tickets',
          sub: 'Sorted by due date',
          link: 'Tickets',
          href: ROUTE.tickets,
          icon: 'tix',
          body: {
            kind: 'list',
            empty: 'No open tickets',
            rows: mine
              .slice()
              .sort((a, b) => ((a.due || '9999') < (b.due || '9999') ? -1 : 1))
              .slice(0, 6)
              .map((t): ListRow => ({
                id: `m-${t.id}`,
                tag: taskKey(t),
                tone: t.type === 'Bug' ? 'red' : t.type === 'Story' ? 'green' : 'blue',
                title: t.title,
                meta: `${statusLabel(t.status)} · ${hm(loggedHours(t, d.entries))} / ${estimateHours(t) || 0}h`,
                right: t.due ? dueLabel(t.due, today) : '',
                rightTone: isOverdue(t) ? 'red' : undefined,
                href: taskHref(t),
              })),
          },
        },
        personalWeek(),
        {
          id: 'my-projects',
          title: 'My active projects',
          sub: 'Epics you are assigned to',
          link: 'Projects',
          href: ROUTE.projects,
          icon: 'ship',
          body: { kind: 'prog', empty: 'No open work yet', rows: epicProgress },
        },
        {
          id: 'my-sprint',
          title: 'My sprint',
          sub: sprint ? `${epicName(sprint.epic)} · ${sprint.name}` : 'No active sprint',
          link: 'Epics & sprints',
          href: ROUTE.tickets,
          icon: 'sprint',
          body: { kind: 'prog', empty: 'No active sprint for your tickets', rows: sprintRowsMine },
        },
        {
          id: 'questions-mine',
          title: 'Questions on my tickets',
          sub: 'Client answers you are waiting for',
          link: 'Tickets',
          href: ROUTE.tickets,
          icon: 'q',
          body: {
            kind: 'list',
            empty: 'Nothing waiting for you',
            rows: questionsOpen
              .filter(q => q.task !== null && mine.some(t => t.id === q.task))
              .map((q): ListRow => {
                const t = top.find(x => x.id === q.task)
                return {
                  id: `qm-${q.id}`,
                  tag: `Q-${q.id}`,
                  tone: 'amber',
                  title: q.title,
                  meta: `${t ? taskKey(t) : ''} · no reply yet`,
                  right: q.when,
                  href: questionHref(q),
                }
              }),
          },
        },
      ],
    }
  }

  const devopsView = (): { kpis: Kpi[]; widgets: Widget[] } => {
    const requestsOpen = d.requests.filter(r => r.status !== 'Done')
    const high = requestsOpen.filter(r => r.prio === 'High' || r.prio === 'Critical').length
    const inSetup = d.devops.projects.filter(p => !NOT_IN_SETUP.includes(p.infra))
    const waiting = d.devops.projects.filter(p => p.from === 'Client')
    const dueReq = requestsOpen.filter(r => r.due && r.due <= weekEnd)
    const nextReq = requestsOpen.map(r => r.due).filter((x): x is string => !!x).sort()[0]
    return {
      kpis: [
        kpi('requests', 'Open requests', String(requestsOpen.length), '', `${high} high priority`, '#E2B23C', ROUTE.devops),
        kpi('setup', 'Projects in setup', String(inSetup.length), '', `${waiting.length} waiting for client`, '#4870E8', ROUTE.devops),
        kpi('due', 'Due this week', String(dueReq.length), '', nextReq ? `Next: ${dayLabel(nextReq)}` : 'Nothing scheduled', '#C0392B', ROUTE.devops),
        kpi('logged', 'Logged this week', hm(myWeekHours), `/ ${WEEK_HOURS}h`, `${weekPct(myWeekHours)}% of working hours`, '#1B2D45', ROUTE.timesheet),
      ],
      widgets: [
        { id: 'infra', title: 'Infra status', sub: 'Steps per project', link: 'DevOps board', href: ROUTE.devops, icon: 'ops', body: { kind: 'status', empty: 'No DevOps projects yet', rows: statusRows() } },
        {
          id: 'requests',
          title: 'DevOps requests',
          sub: 'Raised by project teams',
          link: 'DevOps board',
          href: ROUTE.devops,
          icon: 'tix',
          body: {
            kind: 'list',
            empty: 'No open requests',
            rows: requestsOpen
              .slice()
              .sort((a, b) => ((a.due || '9999') < (b.due || '9999') ? -1 : 1))
              .slice(0, 6)
              .map((r): ListRow => ({
                id: `r-${r.id}`,
                tag: r.prio,
                tone: PRIO_TONE[r.prio],
                title: r.text,
                meta: `${r.key} · raised by ${r.by}`,
                right: r.due ? dayLabel(r.due) : '',
                rightTone: r.due && r.due < today ? 'red' : undefined,
                href: ROUTE.devops,
              })),
          },
        },
        {
          id: 'waiting',
          title: 'Waiting for client',
          sub: 'Blocked until the client answers',
          link: 'DevOps board',
          href: ROUTE.devops,
          icon: 'q',
          body: {
            kind: 'list',
            empty: 'Nothing waiting on a client',
            rows: waiting.map((p): ListRow => ({ id: `w-${p.key}`, tag: p.key, tone: 'amber', title: p.name, meta: `${p.infra} · ${p.act}`, href: ROUTE.devops })),
          },
        },
        personalWeek(),
      ],
    }
  }

  const clientView = (): { kpis: Kpi[]; widgets: Widget[] } => {
    const nextDue = nextDelivery ? short(nextDelivery) : '—'
    const sprint = sprintsActive[0]
    const sprintTasks = sprint ? top.filter(t => t.sprint === sprint.id) : []
    const sprintDone = sprintTasks.filter(t => t.status === 'done').length
    const questionsKpi = kpi(
      'questions',
      'Questions for you',
      String(questionsOpen.length),
      '',
      questionsOpen[0] ? `Oldest ${questionsOpen[0].when}` : 'None open',
      '#C0392B',
      ROUTE.clients,
      { valueColor: questionsOpen.length ? '#C0392B' : undefined },
    )
    const clientQuestions = questionsWidget('Questions waiting for you', 'The team needs an answer to continue', 'Answer', 'All questions answered')
    if (me.role === 'cadmin') {
      const avgPct = companyProjects.length ? Math.round(sum(companyProjects.map(p => p.pct)) / companyProjects.length) : 0
      return {
        kpis: [
          questionsKpi,
          kpi('projects', 'Projects', String(companyProjects.length), '', companyProjects.map(p => p.name).join(', ') || 'No projects yet', '#4870E8', ROUTE.clients),
          kpi('progress', 'Overall progress', `${avgPct}%`, '', `${liveProjects.length} live`, '#3F9079', ROUTE.clients),
          kpi('delivery', 'Next delivery', nextDue, '', liveProjects.length ? 'Next live project' : 'None scheduled', '#4870E8', ROUTE.clients),
        ],
        widgets: [
          {
            id: 'client-epics',
            title: 'Epic progress',
            sub: 'What is being built for your company',
            link: 'Board',
            href: ROUTE.clients,
            icon: 'sprint',
            body: {
              kind: 'prog',
              empty: 'No epics yet',
              rows: companyProjects.flatMap(p => p.epics).map((ep): ProgRow => ({
                id: `ce-${ep.id}`,
                title: ep.name,
                value: `${ep.pct}%`,
                pct: ep.pct,
                barColor: '#3F9079',
                valueColor: '#1B2D45',
                meta: `${ep.sprints} sprints · ${ep.state}`,
                metaColor: '#3B4A5E',
                href: ROUTE.clients,
              })),
            },
          },
          clientQuestions,
          {
            id: 'bugs',
            title: 'Bugs reported',
            sub: 'Reported from the client side',
            link: 'Board',
            href: ROUTE.clients,
            icon: 'bug',
            body: { kind: 'list', empty: 'No bugs reported', rows: clientBugRows(6) },
          },
          {
            id: 'go-live',
            title: 'Go-live readiness',
            sub: 'Setup steps on Viljetech side',
            link: 'Board',
            href: ROUTE.clients,
            icon: 'ship',
            body: { kind: 'status', empty: 'No setup steps yet', rows: statusRows().slice(0, 2) },
          },
        ],
      }
    }
    return {
      kpis: [
        questionsKpi,
        kpi('bugs', 'My open bugs', String(clientBugs.filter(t => t.status !== 'done').length), '', 'Reported from the client side', '#D9534F', ROUTE.clients),
        kpi('delivery', 'Next delivery', nextDue, '', liveProjects.length ? 'Next live project' : 'None scheduled', '#4870E8', ROUTE.clients),
        kpi('sprint', 'Sprint progress', sprint ? `${pctOf(sprintDone, sprintTasks.length)}%` : '—', '', sprint ? `${sprintDone} of ${sprintTasks.length} tasks` : 'No active sprint', '#3F9079', ROUTE.clients),
      ],
      widgets: [
        clientQuestions,
        {
          id: 'my-bugs',
          title: 'My bugs',
          sub: 'Bugs you reported',
          link: 'Report a bug',
          href: ROUTE.clients,
          icon: 'bug',
          body: { kind: 'list', empty: 'No bugs reported yet', rows: clientBugRows(6) },
        },
        {
          id: 'current-sprint',
          title: 'Current sprint',
          sub: sprint ? `${epicName(sprint.epic)} · ${sprint.name}` : 'No active sprint',
          link: 'Timeline',
          href: ROUTE.clients,
          icon: 'sprint',
          body: { kind: 'prog', empty: 'No active sprint', rows: sprintRows(sprintsActive.slice(0, 1)) },
        },
        {
          id: 'delivered',
          title: 'Recently delivered',
          sub: 'Done work, newest first',
          link: 'Board',
          href: ROUTE.clients,
          icon: 'ship',
          body: {
            kind: 'list',
            empty: 'Nothing delivered yet',
            rows: top
              .filter(t => t.status === 'done')
              .slice()
              .sort((a, b) => b.id - a.id)
              .slice(0, 4)
              .map((t): ListRow => ({ id: `dl-${t.id}`, tag: 'Done', tone: 'green', title: t.title, meta: epicName(t.epic), href: ROUTE.clients })),
          },
        },
      ],
    }
  }

  const views: Record<Role, () => { kpis: Kpi[]; widgets: Widget[] }> = {
    super: superView,
    admin: adminView,
    pm: pmView,
    dev: devView,
    devops: devopsView,
    cadmin: clientView,
    cuser: clientView,
  }
  const { kpis, widgets } = views[me.role]()
  const client = isClientRole(me.role)

  return {
    greeting: `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${firstName(me.name)}`,
    dateLine: longDate(today),
    dayShort: dayMonth(today),
    scope: client ? (me.role === 'cadmin' ? `${me.org} · all projects and colleagues` : `${me.org} platform`) : SCOPE[me.role] ?? '',
    org: { label: client ? `Client · ${me.org}` : 'Viljetech', client },
    kpis,
    widgets,
    critical,
    overdue,
    canLog: me.role === 'dev' || me.role === 'devops',
  }
}
