import { addDays, TODAY } from '../lib/dates'
import { createDevopsSeed } from './devops/seed'
import type { Activity, ChatMessage, Db, Epic, Sprint, Task, TimeEntry } from './types'
import { PEOPLE_SEED } from './people/seed'
import { COMPANIES_SEED } from './companies/seed'
import { INTERNAL_PROJECTS_SEED } from './projects/seed'
import { USERS_SEED } from './users/seed'
import { CLIENT_TEAM_SEED } from './clients/seed'

const hist = (who: string, what: string, when: string): Activity => ({ kind: 'history', who, what, when })

const EPICS: Epic[] = [
  {
    id: 'mob',
    name: 'Mobile app',
    p: 0,
    desc: 'Customer app for iOS and Android',
    goal: 'Let clients follow their project and approve work from their phone.',
    story:
      'Native iOS and Android app for clients. Login with BankID, project list with live status, push notifications on status changes, approvals of deliveries in-app, offline read access. Release on App Store and Google Play.',
    criteria: ['Clients can log in with BankID', 'Push notifications for every status change', 'App live on App Store and Google Play'],
    target: '2026-12-20',
    inScope: ['iOS and Android apps', 'BankID login', 'Project status and approvals', 'Push notifications'],
    outScope: ['Time logging in the app', 'Admin features'],
    reqs: [
      'Client logs in with BankID',
      'Client sees all their projects with live status',
      'Client gets a push notification when a status changes',
      'Client approves a delivery in the app',
      'Task list is readable offline',
    ],
    risks: ['App Store review can take up to a week', 'Depends on BankID test accounts from the client'],
    questions: ['Do clients need Swedish and English from day one?'],
  },
  {
    id: 'web',
    name: 'Web app',
    p: 1,
    desc: 'Project management web tool',
    goal: 'Run every Viljetech project from one web tool.',
    story:
      'Web tool for the Viljetech team: epics, sprints and tickets per project, time logging per ticket, client requests to DevOps, and an overview per client.',
    criteria: ['All active projects moved into the tool', 'Time logged per ticket', 'Client requests raised as tickets'],
    target: '2026-11-01',
  },
]

const mkSprints = (epic: string, pre: string, start: string, lens: number[], pairs: string[][]): Sprint[] => {
  let d = start
  return lens.map((L, i) => {
    const end = addDays(d, L - 1)
    const s: Sprint = {
      id: pre + (i + 1),
      epic,
      name: 'Sprint ' + (i + 1),
      start: d,
      end,
      members: pairs[i % pairs.length],
      state: end < TODAY ? 'done' : d <= TODAY ? 'active' : 'planned',
    }
    d = addDays(end, 1)
    return s
  })
}

const buildSprints = (): Sprint[] => {
  const sprints = [
    ...mkSprints('mob', 'm', '2026-09-28', [7, 14, 7, 14, 7, 14, 7, 14], [['Rahul', 'Chary'], ['Bharath Reddy Panyala', 'Vivek']]),
    ...mkSprints('web', 'w', '2026-10-05', [14, 14], [['Bharath Reddy Panyala', 'Rahul'], ['Chary', 'Vivek']]),
  ]
  sprints.forEach(s => {
    if (s.state === 'done') s.summary = 'Completed'
  })
  Object.assign(sprints.find(s => s.id === 'm2')!, {
    goal: 'Clients can log in and get notified',
    why: 'Login and notifications unlock every other feature. Without them clients still email us for updates.',
    goals: ['BankID login works end to end', 'Push notifications on status change', 'No crash when opening a task offline'],
  })
  Object.assign(sprints.find(s => s.id === 'm1')!, {
    goal: 'First-run experience',
    why: 'A clear first run sets expectations and reduces support questions.',
    goals: ['Onboarding screens designed and built'],
    goalsDone: { 0: true },
  })
  return sprints
}

type Seed = Omit<Task, 'epic' | 'sprint' | 'start' | 'time'>
const base = (t: Partial<Seed> & Pick<Seed, 'id' | 'title' | 'type' | 'status' | 'prio' | 'due' | 'acts'>): Seed => ({
  assignee: '',
  contribs: [],
  est: '',
  desc: '',
  atts: [],
  subs: [],
  deps: [],
  ...t,
})

const buildTasks = (sprints: Sprint[]): Task[] => {
  const T0: Seed[] = [
    base({ id: 1, title: 'Add company', type: 'Bug', status: 'todo', prio: 'Low', due: '2026-10-17',
      desc: 'A user should be able to register company directly from here in way of pop up while creating the project.',
      atts: [{ name: 'Screenshot 2026-10-07.png', size: '93 KB', date: '7 Oct 2026' }],
      acts: [hist('Bharath Reddy Panyala', 'added an attachment', '2d ago'), hist('Bharath Reddy Panyala', 'created the task', '2d ago')] }),
    base({ id: 2, title: 'naming system is not uniform', type: 'Bug', status: 'todo', prio: 'Low', due: '2026-10-14', acts: [hist('Bharath Reddy Panyala', 'created the task', '2d ago')] }),
    base({ id: 3, title: 'Creating ticket', type: 'Bug', status: 'todo', prio: 'Low', due: '2026-10-13', acts: [hist('Bharath Reddy Panyala', 'created the task', '2d ago')] }),
    base({ id: 4, title: 'Link tickets to the DevOps board', type: 'Task', status: 'todo', prio: 'Medium', due: '2026-10-20', assignee: 'Rahul', est: '6h', acts: [hist('Rahul', 'created the task', '1d ago')] }),
    base({ id: 5, title: 'Notify the assignee on @mentions', type: 'Task', status: 'todo', prio: 'Medium', due: '2026-10-22', acts: [hist('Rahul', 'created the task', '1d ago')] }),
    base({ id: 6, title: 'Custom statuses per project', type: 'Story', status: 'todo', prio: 'Low', due: '2026-10-28', acts: [hist('Rahul', 'created the task', '1d ago')] }),
    base({ id: 7, title: 'Export timesheet to CSV', type: 'Task', status: 'todo', prio: 'Low', due: '2026-10-30', acts: [hist('Rahul', 'created the task', '1d ago')] }),
    base({ id: 8, title: 'Email reminders before the due date', type: 'Story', status: 'todo', prio: 'Medium', due: '2026-11-04', acts: [hist('Rahul', 'created the task', '1d ago')] }),
    base({ id: 9, title: 'Onboarding screens', type: 'Story', status: 'done', prio: 'Medium', due: '2026-10-03', assignee: 'Rahul', contribs: ['Chary'], est: '12h', acts: [hist('Rahul', 'created the task', '2w ago')] }),
    base({ id: 10, title: 'Login with BankID', type: 'Task', status: 'prog', prio: 'High', due: '2026-10-15', assignee: 'Chary', est: '8h',
      subs: [{ t: 'Test flow', done: false }, { t: 'Error states', done: true }], acts: [hist('Rahul', 'created the task', '1w ago')] }),
    base({ id: 11, title: 'Push notifications setup', type: 'Task', status: 'todo', prio: 'Medium', due: '2026-10-17', assignee: 'Rahul', est: '6h', acts: [hist('Rahul', 'created the task', '1w ago')] }),
    base({ id: 12, title: 'App crashes when opening a task offline', type: 'Bug', status: 'review', prio: 'Critical', due: '2026-10-12', assignee: 'Chary', est: '3h', acts: [hist('Chary', 'created the task', '3d ago')] }),
    base({ id: 13, title: 'Offline mode for the task list', type: 'Story', status: 'todo', prio: 'Medium', due: '2026-10-24', assignee: 'Vivek', acts: [hist('Rahul', 'created the task', '1w ago')] }),
    base({ id: 14, title: 'Profile and settings', type: 'Task', status: 'todo', prio: 'Low', due: '2026-11-06', assignee: 'Bharath Reddy Panyala', acts: [hist('Rahul', 'created the task', '1w ago')] }),
    base({ id: 15, title: 'Dark mode', type: 'Story', status: 'todo', prio: 'Low', due: '', acts: [hist('Rahul', 'created the task', '1w ago')] }),
    base({ id: 16, title: 'App Store and Play Store release', type: 'Task', status: 'todo', prio: 'High', due: '2026-12-18', assignee: 'Rahul', acts: [hist('Rahul', 'created the task', '1w ago')] }),
  ]
  // [epic, sprint, start]
  const PLACE: Record<number, [string, string | null, string]> = {
    1: ['web', 'w1', '2026-10-08'], 2: ['web', 'w1', '2026-10-08'], 3: ['web', 'w1', '2026-10-09'], 4: ['web', 'w1', '2026-10-12'],
    5: ['web', 'w2', '2026-10-19'], 6: ['web', 'w2', '2026-10-21'], 7: ['web', null, '2026-10-21'], 8: ['web', null, '2026-10-26'],
    9: ['mob', 'm1', '2026-09-29'], 10: ['mob', 'm2', '2026-10-06'], 11: ['mob', 'm2', '2026-10-12'], 12: ['mob', 'm2', '2026-10-09'],
    13: ['mob', 'm3', '2026-10-19'], 14: ['mob', 'm4', '2026-10-27'], 15: ['mob', null, '2026-10-10'], 16: ['mob', 'm8', '2026-12-07'],
  }
  const tasks: Task[] = T0.map(t => {
    const [epic, sprint, start] = PLACE[t.id]
    return { ...t, epic, sprint, start, time: {} }
  })

  // Bugs the client reported from the Clients page, each with its own chat.
  const active = (epic: string) => sprints.find(s => s.epic === epic && s.state === 'active')?.id ?? null
  const clientBugs: { title: string; desc: string; epic: string; when: string; chat: ChatMessage[] }[] = [
    {
      title: 'App freezes when I open a task offline',
      desc: 'On my iPhone 14, if I lose signal and open a task from the list, the screen goes white and the app stops responding. I have to close it and open it again.',
      epic: 'mob',
      when: '8 Oct 2026',
      chat: [
        { who: 'Client', side: 'client', text: 'Attaching a screen recording would help? I can send one tomorrow.', when: '8 Oct', files: [] },
        { who: 'Rahul', side: 'team', text: 'Yes please. Also, which app version do you have? Settings → About.', when: '8 Oct', files: [] },
      ],
    },
    {
      title: 'BankID login loops back to the start screen',
      desc: 'After approving in the BankID app, I am sent back to the login screen instead of my projects. It happens about every second time.',
      epic: 'mob',
      when: '9 Oct 2026',
      chat: [{ who: 'Rahul', side: 'team', text: 'Thanks. Does it happen on Wi-Fi as well, or only on mobile data?', when: '9 Oct', files: [] }],
    },
    {
      title: 'Wrong date format on invoices page',
      desc: 'Dates show as 10/09/2026. We use 9 Oct 2026 or 2026-10-09 in Sweden.',
      epic: 'web',
      when: '7 Oct 2026',
      chat: [],
    },
  ]
  clientBugs.forEach((b, i) => {
    tasks.push({
      id: 17 + i,
      title: b.title,
      type: 'Bug',
      status: 'todo',
      prio: 'Medium',
      due: '',
      assignee: '',
      assignees: [],
      contribs: [],
      est: '',
      desc: b.desc,
      atts: [],
      subs: [],
      deps: [],
      epic: b.epic,
      sprint: active(b.epic),
      start: TODAY,
      time: {},
      acts: [hist('Client', 'reported this bug', b.when)],
      clientBug: { reported: b.when, chat: b.chat },
    })
  })
  return tasks
}

/** The directory id of a person, by display name (seed data only). */
export const personIdByName = (name: string): number => PEOPLE_SEED.find(p => p.name === name)?.id ?? 0

const ENTRIES: TimeEntry[] = (
  [
    ['2026-10-09', 'Chary', 'General', 10, '- Finished the BankID test flow\n- Handled cancel and timeout states', 6.5, 0],
    ['2026-10-09', 'Rahul', 'Meeting', 11, '- Sprint 2 check-in with the team', 0, 1],
    ['2026-10-08', 'Rahul', 'General', 11, '- Set up Firebase project and APNs keys', 5, 0],
    ['2026-10-08', 'Chary', 'Review', 12, '- Reproduced the offline crash\n- Added a guard for missing cache', 4, 0.5],
    ['2026-10-07', 'Chary', 'General', 10, '- Wired BankID SDK into the login screen', 7, 0],
    ['2026-10-07', 'Bharath Reddy Panyala', 'General', 1, '- Drafted the add-company popup flow', 6, 0],
    ['2026-10-06', 'Rahul', 'General', 11, '- Researched push notification providers', 3, 1],
    ['2026-10-06', 'Bharath Reddy Panyala', 'Review', 2, '- Listed naming inconsistencies across screens', 5.5, 0],
    ['2026-10-05', 'Vivek', 'Meeting', 4, '- Planning for linking tickets to the DevOps board', 0, 1.5],
    ['2026-10-02', 'Rahul', 'General', 9, '- Final polish on onboarding screens', 6.5, 0],
    ['2026-10-01', 'Chary', 'General', 9, '- Built onboarding illustrations into the screens', 7, 0],
    ['2026-09-30', 'Rahul', 'General', 9, '- Implemented the first two onboarding steps', 6.5, 0],
    ['2026-09-29', 'Rahul', 'General', 9, '- Started onboarding layout and navigation', 3.5, 0],
  ] as const
).map((r, i) => ({
  id: i + 1,
  date: r[0],
  userId: personIdByName(r[1]),
  user: r[1],
  type: r[2],
  task: r[3],
  notes: r[4],
  bill: r[5],
  non: r[6],
}))

/** Hours logged on tickets before the shared store existed. They are time entries now, so every page reads the same hours. */
const TICKET_HOURS: [string, string, number, number][] = [
  ['2026-10-08', 'Bharath Reddy Panyala', 1, 1.5],
  ['2026-10-09', 'Bharath Reddy Panyala', 1, 2],
  ['2026-10-09', 'Rahul', 4, 1],
  ['2026-10-06', 'Chary', 10, 3],
  ['2026-10-07', 'Chary', 10, 2.5],
  ['2026-10-08', 'Chary', 10, 2],
  ['2026-10-09', 'Chary', 12, 2],
]
const ALL_ENTRIES: TimeEntry[] = [
  ...ENTRIES,
  ...TICKET_HOURS.map(([date, user, task, bill], i) => ({
    id: ENTRIES.length + i + 1,
    date,
    userId: personIdByName(user),
    user,
    type: 'General',
    task,
    notes: '',
    bill,
    non: 0,
  })),
]

export const DB_VERSION = 4

export const createSeed = (): Db => {
  const sprints = buildSprints()
  return {
    version: DB_VERSION,
    workspace: {
      statuses: [
        { id: 'todo', name: 'To do', p: 0 },
        { id: 'prog', name: 'In progress', p: 1 },
        { id: 'review', name: 'Review', p: 2 },
        { id: 'done', name: 'Done', p: 3 },
      ],
      epics: EPICS,
      sprints,
      devopsLinks: { mob: 'OPS-101', web: 'OPS-107' },
    },
    tasks: buildTasks(sprints),
    entries: ALL_ENTRIES,
    weekSubmissions: [],
    people: PEOPLE_SEED,
    companies: COMPANIES_SEED,
    internalProjects: INTERNAL_PROJECTS_SEED,
    ...USERS_SEED,
    clientTeam: CLIENT_TEAM_SEED,
    questions: [
      {
        id: 1,
        by: 'Rahul',
        title: 'Which languages at launch?',
        text: 'Should the app support only Swedish at launch, or English too? This decides how we set up translations for every screen.',
        when: '2 days ago',
        task: 10,
        answer: '',
      },
      {
        id: 2,
        by: 'Chary',
        title: 'Logo files for the app icon',
        text: 'Can we use your existing logo files for the app icon, or do you have a new version? Please attach the source files (SVG or AI) if you have them.',
        when: 'yesterday',
        task: null,
        answer: 'Use the new version, we will send it this week.',
      },
    ],
    devops: createDevopsSeed(),
    requests: [
      {
        id: 1, key: 'OPS-101', pname: 'Daco platform', rkey: 'REQ-1', type: 'Environment', prio: 'High', to: 'Chary',
        text: 'Need a staging environment for the Sprint 2 build', by: 'Rahul', when: 'yesterday', raised: '2026-10-09', status: 'In progress',
        comments: [
          { by: 'Rahul', text: 'We need it before Friday for client testing.', when: 'yesterday', side: 'tickets' },
          { by: 'Chary', text: 'Setting it up now, will share access by tomorrow morning.', when: '2h ago', side: 'devops' },
        ],
      },
      {
        id: 2, key: 'OPS-101', pname: 'Daco platform', rkey: 'REQ-2', type: 'Access', prio: 'Medium', to: '',
        text: 'Give Vivek read access to the production logs', by: 'Rahul', when: '2d ago', raised: '2026-10-08', status: 'Open', comments: [],
      },
    ],
  }
}
