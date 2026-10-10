import type { Priority, SprintState, TaskType } from '../api/types'

/**
 * People on the project. On the Clients page every avatar is a plain grey
 * square with initials: clients never see photos or personal colours.
 */
export const MEMBERS: Record<string, { i: string; bg: string }> = {
  Rahul: { i: 'R', bg: '#56657A' },
  'Bharath Reddy Panyala': { i: 'BP', bg: '#56657A' },
  Chary: { i: 'C', bg: '#56657A' },
  Vivek: { i: 'V', bg: '#56657A' },
}
export const PEOPLE = Object.keys(MEMBERS)

/** The signed-in user. */
export const ME = 'Rahul'

export type Person = { name: string; i: string; bg: string }

export const person = (name: string): Person => {
  const m = MEMBERS[name]
  return { name, i: m ? m.i : (name || '?')[0], bg: m ? m.bg : '#56657A' }
}

/** Personal colours the team sees on the Tickets page (`MEM` in Tickets.dc.html). */
export const TEAM_COLORS: Record<string, string> = {
  Rahul: '#4870E8',
  'Bharath Reddy Panyala': '#9F89E5',
  Chary: '#B98A2F',
  Vivek: '#3E908F',
}

/** Same as `person`, with the team's personal colours. */
export const teamPerson = (name: string): Person => {
  const p = person(name)
  return TEAM_COLORS[name] ? { ...p, bg: TEAM_COLORS[name] } : p
}

/** [colour, soft, ink] */
export const TYPES: Record<TaskType, [string, string, string]> = {
  Bug: ['#D2724A', '#F6DDD0', '#7A3818'],
  Task: ['#4870E8', '#DCE5FA', '#1F3FAF'],
  Story: ['#3F9079', '#D6E9E2', '#195040'],
}
export const TYPE_LIST = Object.keys(TYPES) as TaskType[]

export const TYPE_ICON: Record<TaskType, string> = {
  Bug: 'M8 6V4M16 6V4M6 10h12M6 14h12M8 6h8a2 2 0 0 1 2 2v8a6 6 0 0 1-12 0V8a2 2 0 0 1 2-2z',
  Task: 'M5 12l4 4 10-10',
  Story: 'M6 4h12v16l-6-4-6 4z',
}

/** [text, background] */
export const PRIO: Record<Priority, [string, string]> = {
  Critical: ['#FFFFFF', '#C0392B'],
  Urgent: ['#7A3818', '#F6DDD0'],
  High: ['#7A5C0E', '#FBEDC2'],
  Medium: ['#1F3FAF', '#DCE5FA'],
  Low: ['#22354C', '#E7EEFB'],
}
export const PRIO_LIST = Object.keys(PRIO) as Priority[]

export const PRIO_ICON_COLOR: Record<Priority, string> = {
  Critical: '#C0392B',
  Urgent: '#D2724A',
  High: '#B98A2F',
  Medium: '#4870E8',
  Low: '#56657A',
}

export const PRIO_ICON: Record<Priority, string> = {
  Critical: 'M3 9.5l5-4 5 4M3 13.5l5-4 5 4',
  Urgent: 'M3 9.5l5-4 5 4M3 13.5l5-4 5 4',
  High: 'M3 11l5-5 5 5',
  Medium: 'M3 6h10M3 10.5h10',
  Low: 'M3 5.5l5 5 5-5',
}

/** Palette used for statuses and epics: [colour, soft, ink] */
export const PAL: [string, string, string][] = [
  ['#4870E8', '#DCE5FA', '#1F3FAF'],
  ['#9F89E5', '#E6DFFA', '#3F2E94'],
  ['#B98A2F', '#FBEDC2', '#7A5C0E'],
  ['#3F9079', '#D6E9E2', '#195040'],
  ['#D2724A', '#F6DDD0', '#7A3818'],
  ['#3E908F', '#DFF1F0', '#1F6F6E'],
]
export const pal = (p: number) => PAL[p % PAL.length]

/** Sprint state colours: [ink, soft, dot, label] */
export const SPRINT_STATE: Record<SprintState, [string, string, string, string]> = {
  done: ['#195040', '#D6E9E2', '#3F9079', 'Done'],
  active: ['#1F3FAF', '#DCE5FA', '#4870E8', 'Active'],
  planned: ['#22354C', '#E7EEFB', '#A9B6C5', 'Planned'],
}

/** DevOps status colours: [ink, soft, dot] */
export const devopsTone = (v: string): [string, string, string] =>
  /Completed|Production/.test(v)
    ? ['#195040', '#D6E9E2', '#3F9079']
    : /Waiting|Inform|Escalate/.test(v)
      ? ['#7A5C0E', '#FBEDC2', '#B98A2F']
      : /progress|Development|Testing|validation/.test(v)
        ? ['#1F3FAF', '#DCE5FA', '#4870E8']
        : ['#22354C', '#E7EEFB', '#A9B6C5']

export const REQUEST_STATUS: Record<string, [string, string]> = {
  Open: ['#7A5C0E', '#FBEDC2'],
  'In progress': ['#1F3FAF', '#DCE5FA'],
  Done: ['#195040', '#D6E9E2'],
}

/** Tags shown for questions raised by the team: type and priority. */
export const questionTags = (q: { qtype?: string; qprio?: string }) => {
  const T: { t: string; bg: string; c: string }[] = []
  const TY: Record<string, [string, string]> = {
    Blocker: ['#FBE3DF', '#C0392B'],
    Information: ['#E7EEFB', '#1F3FAF'],
    Requirement: ['#D6E9E2', '#195040'],
  }
  const PR: Record<string, [string, string]> = {
    Critical: ['#C0392B', '#FFFFFF'],
    High: ['#FBEDC2', '#7A5C0E'],
    Medium: ['#DCE5FA', '#1F3FAF'],
    Low: ['#E7EEFB', '#22354C'],
  }
  if (q.qtype) {
    const c = TY[q.qtype] || ['#F3F0FC', '#3F2E94']
    T.push({ t: q.qtype, bg: c[0], c: c[1] })
  }
  if (q.qprio && PR[q.qprio]) {
    const c = PR[q.qprio]
    T.push({ t: (q.qprio === 'Critical' ? '● ' : '') + q.qprio + ' priority', bg: c[0], c: c[1] })
  }
  return T
}
