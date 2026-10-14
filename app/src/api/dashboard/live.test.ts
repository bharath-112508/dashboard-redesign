import { describe, expect, it } from 'vitest'
import type { Company, LeaveRequest, Person, Task, TimeEntry } from '../types'
import { approvalRows, budgetsFrom, leaveRows, pendingCounts } from './live'

const task = (id: string, epic: string, est: string, extra: Partial<Task> = {}) => ({ id, epic, est, parent: null, ...extra }) as unknown as Task
const entry = (task: string | null, bill: number, non = 0, project?: string) => ({ id: 'e' + Math.random(), task, bill, non, project }) as unknown as TimeEntry
const company = (name: string, projects: { id: string; name: string; epics: string[] }[], archived = false) =>
  ({ id: name, name, archived, projects: projects.map(p => ({ ...p, epics: p.epics.map(id => ({ id })) })) }) as unknown as Company

describe('budgetsFrom', () => {
  it('uses the tickets\' estimates as the budget and the logged hours as used, most used first', () => {
    const companies = [
      company('Aurora', [
        { id: 'p1', name: 'Portal', epics: ['s1'] },
        { id: 'p2', name: 'Empty', epics: [] },
      ]),
      company('Nordmark', [{ id: 'p3', name: 'Fleet', epics: ['s3'] }]),
      company('Gone', [{ id: 'p4', name: 'Old', epics: ['s4'] }], true),
    ]
    const tasks = [task('t1', 's1', '40'), task('t2', 'none~p1', '10'), task('t3', 's3', '20'), task('t4', 's4', '5'), task('t5', 's1', '8', { parent: 't1' } as never)]
    const entries = [entry('t1', 30, 5), entry(null, 10, 0, 'c:p1'), entry('t3', 25)]
    expect(budgetsFrom(companies, tasks, entries)).toEqual([
      { title: 'Nordmark · Fleet', hours: 25, sold: 20, meta: '25h of 20h · 5h over budget' },
      { title: 'Aurora · Portal', hours: 45, sold: 50, meta: '45h of 50h · 5h left' },
    ])
  })
})

const people = [{ id: 'u1', name: 'Rahul' }, { id: 'u2', name: 'Chary' }] as unknown as Person[]
const req = (id: string, userId: string, type: string, from: string, to: string, status: LeaveRequest['status']): LeaveRequest => ({ id, userId, type, from, to, reason: '', status })

describe('leave figures', () => {
  const leave = [
    req('1', 'u1', 'Casual Leave', '2026-10-13', '2026-10-15', 'Approved'),
    req('2', 'u2', 'Sick Leave', '2026-10-20', '2026-10-22', 'Pending'),
    req('3', 'u1', 'Compensatory Off', '2026-10-19', '2026-10-19', 'Pending'),
    req('4', 'u2', 'Casual Leave', '2026-10-01', '2026-10-02', 'Approved'),
  ]

  it('lists who is off today and what waits for a decision', () => {
    expect(leaveRows(leave, people, '2026-10-14')).toEqual([
      { tag: 'Off today', tone: 'grey', title: 'Rahul', meta: 'Casual Leave · back Fri 16 Oct' },
      { tag: 'Pending', tone: 'amber', title: 'Rahul · 1 day', meta: 'Compensatory Off · 19 Oct – 19 Oct', right: 'Approve', rightTone: 'ink' },
      { tag: 'Pending', tone: 'amber', title: 'Chary · 3 days', meta: 'Sick Leave · 20 Oct – 22 Oct', right: 'Approve', rightTone: 'ink' },
    ])
  })

  it('keeps the list short: upcoming requests first, then the latest overdue ones, five rows at most', () => {
    const many = [
      req('a', 'u1', 'Casual Leave', '2026-07-01', '2026-07-01', 'Pending'),
      req('b', 'u1', 'Casual Leave', '2026-09-01', '2026-09-01', 'Pending'),
      ...['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-26'].map((d, i) => req('n' + i, 'u2', 'Casual Leave', d, d, 'Pending')),
    ]
    const rows = leaveRows(many, people, '2026-10-14')
    expect(rows).toHaveLength(5)
    expect(rows.map(r => r.meta.split(' · ')[1])).toEqual(['20 Oct – 20 Oct', '21 Oct – 21 Oct', '22 Oct – 22 Oct', '23 Oct – 23 Oct', '26 Oct – 26 Oct'])
    expect(leaveRows(many.slice(0, 3), people, '2026-10-14').map(r => r.meta.split(' · ')[1])).toEqual(['20 Oct – 20 Oct', '1 Sep – 1 Sep', '1 Jul – 1 Jul'])
  })

  it('counts pending leave and comp-off apart, and lists them for approval', () => {
    expect(pendingCounts(leave)).toEqual({ leave: 1, compoff: 1, oldestLeave: '2026-10-20' })
    expect(approvalRows(leave, people, '2026-10-14').map(r => [r.tag, r.title])).toEqual([
      ['Comp-off', 'Rahul · Compensatory Off'],
      ['Leave', 'Chary · Sick Leave'],
    ])
  })
})

describe('buildDashboard', () => {
  it("uses the real figures in API mode and the design's samples in mock mode", async () => {
    const { buildDashboard } = await import('./model')
    const { createDevopsSeed } = await import('../devops/seed')
    const { BUDGETS } = await import('./static')
    const data = {
      tasks: [task('t1', 's1', '40')],
      entries: [entry('t1', 10)],
      questions: [],
      companies: [company('Aurora', [{ id: 'p1', name: 'Portal', epics: ['s1'] }])],
      people,
      workspace: { statuses: [], epics: [], sprints: [], devopsLinks: {} },
      devops: createDevopsSeed(),
      requests: [],
      leave: [req('2', 'u2', 'Sick Leave', '2026-10-20', '2026-10-22', 'Pending')],
    }
    const me = { personId: 'a0', name: 'Admin', email: 'a@x', role: 'super' as const, org: 'Viljetech' }
    const widget = (live: boolean, id: string) => buildDashboard({ ...data, live }, me, '2026-10-14').widgets.find(w => w.id === id)!
    const titles = (w: { body: unknown }) => ((w.body as { rows: { title: string }[] }).rows ?? []).map(r => r.title)
    expect(titles(widget(true, 'budget'))).toEqual(['Aurora · Portal'])
    expect(titles(widget(false, 'budget'))).toEqual(BUDGETS.map(b => b.title))
    expect(titles(widget(true, 'leave'))).toEqual(['Chary · 3 days'])
  })
})
