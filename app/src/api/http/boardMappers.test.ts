import { describe, expect, it } from 'vitest'
import {
  epicFrom,
  noEpicFor,
  prioFrom,
  prioTo,
  realSprintId,
  sprintStateFrom,
  sprintStateTo,
  sprintsFrom,
  statusIdFrom,
  statusKeyFrom,
  taskBody,
  taskFrom,
  typeFrom,
  typeTo,
  type BackendSprint,
  type BackendStory,
  type BackendTask,
} from './boardMappers'

const NAMES: Record<string, string> = { u1: 'Chary', u2: 'Rahul' }
const names = (id: string) => NAMES[id] ?? ''
const ids = (name: string) => Object.keys(NAMES).find(k => NAMES[k] === name)

const bt = (over: Partial<BackendTask> = {}): BackendTask => ({
  id: 't1',
  project_id: 'p1',
  task_number: 12,
  sprint_id: null,
  story_id: 'e1',
  parent_task_id: null,
  title: 'Login',
  description: 'Body',
  status: 'in_progress',
  priority: 'high',
  issue_type: 'task',
  labels: [],
  due_date: '2026-10-20',
  start_date: null,
  estimated_hours: 6,
  assignee_ids: ['u1'],
  primary_assignee_id: 'u1',
  collaborator_ids: ['u2'],
  source: null,
  depends_on_task_ids: ['t9'],
  created_at: '2026-10-07T09:00:00.000Z',
  ...over,
})

describe('value mappings', () => {
  it('maps priorities both ways', () => {
    const pairs = [['Critical', 'critical'], ['Urgent', 'urgent'], ['High', 'high'], ['Medium', 'medium'], ['Low', 'low']] as const
    for (const [app, be] of pairs) {
      expect(prioFrom(be)).toBe(app)
      expect(prioTo(app)).toBe(be)
    }
  })

  it('maps types both ways; improvement reads as Story', () => {
    expect([typeFrom('bug'), typeFrom('task'), typeFrom('story'), typeFrom('improvement')]).toEqual(['Bug', 'Task', 'Story', 'Story'])
    expect([typeTo('Bug'), typeTo('Task'), typeTo('Story')]).toEqual(['bug', 'task', 'story'])
  })

  it('maps statuses both ways; backend bug reads as To do; custom keys pass through', () => {
    expect(['to_do', 'in_progress', 'review', 'done', 'bug', 'qa'].map(statusIdFrom)).toEqual(['todo', 'prog', 'review', 'done', 'todo', 'qa'])
    expect(['todo', 'prog', 'review', 'done', 'qa'].map(statusKeyFrom)).toEqual(['to_do', 'in_progress', 'review', 'done', 'qa'])
  })

  it('maps sprint states both ways', () => {
    expect(['planned', 'active', 'completed'].map(sprintStateFrom)).toEqual(['planned', 'active', 'done'])
    expect((['planned', 'active', 'done'] as const).map(sprintStateTo)).toEqual(['planned', 'active', 'completed'])
  })

  it('strips the epic part of a legacy sprint id', () => {
    expect(realSprintId('s1~e2')).toBe('s1')
    expect(realSprintId('s1')).toBe('s1')
  })
})

describe('epics', () => {
  const story: BackendStory = {
    id: 'e1',
    project_id: 'p1',
    title: 'Web app',
    description: 'All web work',
    goal: 'Ship it',
    user_story: 'As a PM…',
    criteria: ['Fast', 'Safe'],
    criteria_done: [1],
    target_date: '2026-12-01',
    in_scope: ['Login'],
    out_scope: ['Mobile'],
    requirements: ['SSO'],
    risks: ['Time'],
    open_questions: ['Which IdP?'],
  }

  it('maps a story to an epic with its document', () => {
    expect(epicFrom(story)).toMatchObject({
      id: 'e1',
      name: 'Web app',
      desc: 'All web work',
      goal: 'Ship it',
      story: 'As a PM…',
      criteria: ['Fast', 'Safe'],
      critDone: { 1: true },
      target: '2026-12-01',
      inScope: ['Login'],
      outScope: ['Mobile'],
      reqs: ['SSO'],
      risks: ['Time'],
      questions: ['Which IdP?'],
    })
    expect(epicFrom(story).p).toBeGreaterThanOrEqual(0)
    expect(epicFrom(story).p).toBeLessThan(8)
  })

  it('gives each project a "No epic" epic', () => {
    expect(noEpicFor('p1')).toMatchObject({ id: 'none~p1', name: 'No epic' })
  })
})

describe('sprintsFrom', () => {
  const sp = (over: Partial<BackendSprint> = {}): BackendSprint => ({
    id: 's1',
    project_id: 'p1',
    name: 'Sprint 3',
    goal: 'Login',
    start_date: '2026-10-05',
    end_date: '2026-10-16',
    status: 'active',
    story_id: null,
    member_ids: ['u1', 'u9'],
    goals: ['A', 'B'],
    goals_done: [0],
    summary: 'S',
    why: 'W',
    ...over,
  })

  it('gives a sprint of an epic one entry under that epic', () => {
    expect(sprintsFrom(sp({ story_id: 'e1' }), ['e2'], names)).toEqual([
      {
        id: 's1',
        epic: 'e1',
        name: 'Sprint 3',
        start: '2026-10-05',
        end: '2026-10-16',
        members: ['Chary'],
        state: 'active',
        goal: 'Login',
        summary: 'S',
        why: 'W',
        goals: ['A', 'B'],
        goalsDone: { 0: true },
      },
    ])
  })

  it('shows a legacy sprint under every epic its tasks are in, with the same name and dates', () => {
    const out = sprintsFrom(sp(), ['e1', 'e2', 'e1'], names)
    expect(out.map(s => [s.id, s.epic, s.name, s.start, s.end])).toEqual([
      ['s1~e1', 'e1', 'Sprint 3', '2026-10-05', '2026-10-16'],
      ['s1~e2', 'e2', 'Sprint 3', '2026-10-05', '2026-10-16'],
    ])
  })

  it('keeps a legacy sprint with no tasks under its project\'s "No epic"', () => {
    expect(sprintsFrom(sp(), [], names).map(s => [s.id, s.epic])).toEqual([['s1~none~p1', 'none~p1']])
    expect(realSprintId('s1~none~p1')).toBe('s1')
  })
})

describe('taskFrom', () => {
  const ctx = (children: BackendTask[] = []) => ({
    key: 'AFSP-12',
    sprintIdFor: () => 's1~e1',
    epicIdFor: () => 'e1',
    names,
    children,
  })

  it('maps a backend task to the board shape', () => {
    expect(taskFrom(bt(), ctx())).toEqual({
      id: 't1',
      subKey: 'AFSP-12',
      title: 'Login',
      type: 'Task',
      status: 'prog',
      prio: 'High',
      due: '2026-10-20',
      start: '',
      assignee: 'Chary',
      assignees: ['Chary'],
      contribs: ['Rahul'],
      est: '6h',
      desc: 'Body',
      atts: [],
      subs: [],
      deps: ['t9'],
      epic: 'e1',
      sprint: 's1~e1',
      time: {},
      acts: [],
    })
  })

  it('reads no estimate as an empty one', () => {
    expect(taskFrom(bt({ estimated_hours: 0 }), ctx()).est).toBe('')
  })

  it('lists linked child tasks as subtasks, in order', () => {
    const kids = [
      bt({ id: 'c1', title: 'Test flow', status: 'done', due_date: '2026-10-11', primary_assignee_id: 'u2', assignee_ids: ['u2'], description: 'n1' }),
      bt({ id: 'c2', title: 'Error states', status: 'to_do', due_date: null, primary_assignee_id: null, assignee_ids: [], description: '' }),
    ]
    expect(taskFrom(bt(), ctx(kids)).subs).toEqual([
      { t: 'Test flow', done: true, sid: 'c1', due: '2026-10-11', assignee: 'Rahul', note: 'n1' },
      { t: 'Error states', done: false, sid: 'c2', due: '', assignee: '', note: '' },
    ])
  })

  it('marks a child task with its parent', () => {
    expect(taskFrom(bt({ parent_task_id: 't0' }), ctx()).parent).toBe('t0')
  })

  it('marks only client-raised tasks as client bugs', () => {
    expect(taskFrom(bt({ source: 'client' }), ctx()).clientBug).toEqual({ reported: '07 Oct 2026', chat: [] })
    expect(taskFrom(bt(), ctx()).clientBug).toBeUndefined()
  })
})

describe('taskBody', () => {
  const ctx = {
    ids,
    realSprintId: (id: string | null) => (id ? realSprintId(id) : null),
    storyIdOf: (epic: string) => (epic.startsWith('none~') ? null : epic),
  }

  it('sends only the fields given', () => {
    expect(taskBody({ title: 'New' }, ctx)).toEqual({ title: 'New' })
  })

  it('maps every editable field', () => {
    expect(
      taskBody({ type: 'Story', status: 'prog', prio: 'Urgent', due: '', start: '2026-10-12', est: '6h', desc: 'D', contribs: ['Rahul'] }, ctx),
    ).toEqual({
      issue_type: 'story',
      status: 'in_progress',
      priority: 'urgent',
      due_date: null,
      start_date: '2026-10-12',
      estimated_hours: 6,
      description: 'D',
      collaborator_ids: ['u2'],
    })
    expect(taskBody({ est: '' }, ctx)).toEqual({ estimated_hours: 0 })
  })

  it('maps assignee names to ids (the backend keeps the primary assignee in step) and leaves unknown names out', () => {
    expect(taskBody({ assignees: ['Chary', 'Ghost'] }, ctx)).toEqual({ assignee_ids: ['u1'] })
    expect(taskBody({ assignee: 'Rahul' }, ctx)).toEqual({ assignee_ids: ['u2'] })
    expect(taskBody({ assignee: '' }, ctx)).toEqual({ assignee_ids: [] })
  })

  it('maps epic and sprint to the real backend ids', () => {
    expect(taskBody({ epic: 'none~p1' }, ctx)).toEqual({ story_id: null })
    expect(taskBody({ epic: 'e2' }, ctx)).toEqual({ story_id: 'e2' })
    expect(taskBody({ sprint: 's1~e2' }, ctx)).toEqual({ sprint_id: 's1' })
    expect(taskBody({ sprint: null }, ctx)).toEqual({ sprint_id: null })
  })
})
