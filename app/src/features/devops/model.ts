import { escalationIndex } from '../../api/devops/rules'
import type { DvProject, DvSettings } from '../../api/devops/types'
import { TODAY } from '../../lib/dates'

/** The DevOps board's "today": the app-wide fixed date. */
export { TODAY }

/* ───────────── Colours ───────────── */

/** [ink, soft, dot] */
type Tone = [string, string, string]
export const T: Record<string, Tone> = {
  gray: ['#22354C', '#E7EEFB', '#56657A'],
  orange: ['#7A5C0E', '#FBEDC2', '#B98A2F'],
  blue: ['#1F3FAF', '#DCE5FA', '#4870E8'],
  purple: ['#3F2E94', '#E6DFFA', '#9F89E5'],
  indigo: ['#1F3FAF', '#DCE5FA', '#4870E8'],
  green: ['#195040', '#D6E9E2', '#3F9079'],
  red: ['#7A3818', '#F6DDD0', '#D2724A'],
  teal: ['#1F6F6E', '#DFF1F0', '#3E908F'],
}

const TONE: Record<string, keyof typeof T> = {
  'Reminder 3': 'blue', ALSO: 'indigo', 'Client environment': 'teal', 'Dev project deployment': 'purple',
  'Prod product deployment': 'teal', 'Deployment Completed': 'green', 'Internally deployment': 'orange',
  'Adding new services': 'indigo', 'Client onboarding': 'blue', 'Client first tenant setup': 'blue',
  'First project deployment': 'purple', 'CI/CD setup': 'teal', 'Waiting for client': 'blue', High: 'red', Low: 'gray',
  DevOps: 'blue', 'Inform Marcus': 'red', Escalate: 'red', 'Reminder 1': 'blue', 'Reminder 2': 'blue',
  'Call client': 'orange', 'Not started': 'gray', 'Not set': 'gray', 'Not required': 'gray', '—': 'gray',
  'Waiting for client access': 'orange', Medium: 'orange', Client: 'orange', 'Client validation': 'orange',
  'In progress': 'blue', Waiting: 'blue', Development: 'blue', 'Internally completed': 'purple', Testing: 'purple',
  Completed: 'green', Production: 'green', Critical: 'red', 'Development team': 'teal',
}

/** Colours of a status / priority / phase label: [ink, soft, dot]. Unknown labels are grey. */
export const tone = (label: string | null | undefined): Tone => T[TONE[label ?? ''] || 'gray']

/** Priority arrow icons (16×16): [colour, path]. */
export const PRIO_ICON: Record<string, [string, string]> = {
  Critical: ['#dc2f45', 'M3 9.5l5-4 5 4M3 13.5l5-4 5 4'],
  High: ['#ea6a12', 'M3 11l5-5 5 5'],
  Medium: ['#d99a00', 'M3 6h10M3 10.5h10'],
  Low: ['#2f6fde', 'M3 5.5l5 5 5-5'],
  'Not set': ['#b0b3ba', 'M4 8h8'],
}
export const prioIcon = (p: string) => PRIO_ICON[p] || PRIO_ICON['Not set']

const TILE = ['#5e6c84', '#6e5dc6', '#1d7afc', '#22a06b', '#c9372c', '#946f00', '#1f845a', '#8f7ee7']
/** Colour of a project's initials tile. */
export const tileOf = (n: string) => {
  let s = 0
  for (const c of n) s = (s * 31 + c.charCodeAt(0)) >>> 0
  return TILE[s % TILE.length]
}
export const tileText = (n: string) =>
  n
    .replace(/[^A-Za-zÅÄÖåäö ]/g, '')
    .split(' ')
    .filter(Boolean)
    .map(w => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() || n[0]

/** The tile shows the client's initials, or the project's when it has no client. */
export const tileName = (p: { client?: string; name: string }) => p.client || p.name

/** Day label of a release: "Today", or "9 Oct". */
export const releaseDay = (iso: string) => (iso.slice(0, 10) === TODAY ? 'Today' : shortD(iso))

/** Owner avatar colours on the board. */
const AV: Record<string, string> = { Chary: '#B98A2F', Vivek: '#30b0c7', Raj: '#5e5ce6', Ganesh: '#3F9079', Rahul: '#4870E8' }
export const ownerColor = (n: string | null | undefined) => (n && AV[n]) || '#A9B6C5'

/** Avatar colours in chats and request tickets. */
const MEM2: Record<string, [string, string]> = {
  Chary: ['C', '#B98A2F'],
  Vivek: ['V', '#3E908F'],
  Raj: ['R', '#9F89E5'],
  Ganesh: ['G', '#3F9079'],
  Rahul: ['R', '#4870E8'],
}
export const member = (n: string) => {
  const m = MEM2[n]
  return { i: m ? m[0] : (n || '?')[0], bg: m ? m[1] : '#56657A' }
}

/* ───────────── Dates ───────────── */

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-10-12" → "12 Oct 2026"; "2026-10-12T07:00" → "12 Oct 2026, 07:00". */
export const fmtD = (iso: string | null | undefined) => {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return d + ' ' + MON[+m - 1] + ' ' + y + (iso.length > 10 ? ', ' + iso.slice(11, 16) : '')
}
/** Date without the time: "12 Oct 2026". */
export const fmtDay = (iso: string | null | undefined) => fmtD(iso ? iso.slice(0, 10) : iso)
/** "12 Oct" (with the year when it isn't this year). */
export const shortD = (iso: string | null | undefined) => {
  if (!iso) return ''
  const [y, m, d] = iso.slice(0, 10).split('-')
  return +d + ' ' + MON[+m - 1] + (y !== TODAY.slice(0, 4) ? ' ' + y : '')
}
/** "04 Oct": the first six characters of fmtD, as the prototype shows it. */
export const ddMon = (iso: string) => fmtD(iso).slice(0, 6)

export const dayOf = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null)

export const addD = (iso: string, n: number) => {
  const t = iso.length > 10 ? iso.slice(10, 16) : ''
  const d = new Date(iso.slice(0, 10) + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10) + t
}
export const toDT = (s: string, remTime: string) => (s.length === 10 ? s + 'T' + (remTime || '07:00') : s.slice(0, 16))
export const addH = (dt: string, n: number, remTime = '07:00') => {
  const d = new Date(toDT(dt, remTime) + ':00Z')
  d.setUTCHours(d.getUTCHours() + n)
  return d.toISOString().slice(0, 16)
}
export const diffD = (a: string, b: string) =>
  Math.round((new Date(a.slice(0, 10) + 'T12:00:00Z').getTime() - new Date(b.slice(0, 10) + 'T12:00:00Z').getTime()) / 864e5)

/** "in 3 days" / "2 days ago" / "Today", and its colour (red when late and `warn`). */
export const relD = (iso: string | null | undefined, warn: boolean): [string, string] => {
  if (!iso) return ['', '#56657A']
  const d = diffD(iso, TODAY)
  return [
    d === 0 ? 'Today' : d > 0 ? 'in ' + d + ' day' + (d > 1 ? 's' : '') : -d + ' day' + (d < -1 ? 's' : '') + ' ago',
    d < 0 && warn ? '#A5502C' : d === 0 ? '#7A5C0E' : '#3B4A5E',
  ]
}

export const movedLabel = (due: string, init: string) => {
  const d = diffD(due, init)
  return (d > 0 ? '+' : '−') + Math.abs(d) + ' d'
}

/* ───────────── Sequences and phases ───────────── */

export const ladderNames = (s: DvSettings) => s.ladder.map(x => x.name)
/** The client step from which a project counts as escalated (by name in Settings). */
export const escIndex = (s: DvSettings) => escalationIndex(s)
/** Hours from the start of the sequence for each default client step. */
export const ladderOffsets = (s: DvSettings) => {
  let acc = 0
  return s.ladder.map((x, i) => (acc += i ? x.hours : 0))
}
/** The project's client steps: the defaults plus any it added. */
export const lad = (p: DvProject, s: DvSettings) => [...ladderNames(s), ...(p.xsteps || []).map(x => x.name)]
export const offs = (p: DvProject, s: DvSettings) => [...ladderOffsets(s), ...(p.xsteps || []).map(x => x.off)]

/** Planned date and time of every client step. */
export const seq = (p: DvProject, s: DvSettings) => {
  const O = offs(p, s)
  const rt = s.rules.remTime
  const anchor =
    p.seqStart ||
    addH(addD(TODAY, -14) + 'T' + rt, -(ladderOffsets(s)[Math.min(p.step || 0, s.ladder.length - 1)] || 0), rt)
  return lad(p, s).map((_, i) => (p.dates?.[i] ? toDT(p.dates[i], rt) : addH(anchor, O[i], rt)))
}

export const devList = (s: DvSettings) => s.devPhases.map(x => x.name)
export const devListFor = (p: DvProject, s: DvSettings) => p.devSteps || devList(s)
export const devDays = (s: DvSettings, name: string) => s.devPhases.find(x => x.name === name)?.days ?? null
export const statusDesc = (s: DvSettings, name: string) => s.statuses.find(x => x.name === name)?.desc || ''
/** The project's own status description, or the default from Settings, or its current phase. */
export const infraText = (p: DvProject, s: DvSettings) => p.infraNote ?? (statusDesc(s, p.infra) || p.phase || '')

/* ───────────── Filters ───────────── */

export type FilterId = 'all' | 'due' | 'client' | 'internal' | 'esc' | 'moved'

export const FILTERS: [FilterId, string, (p: DvProject, s: DvSettings) => boolean][] = [
  ['all', 'All', () => true],
  ['due', 'Due now', p => p.overdue],
  ['client', 'Client', p => p.from === 'Client' && p.step != null && p.infra !== 'Not started'],
  [
    'internal',
    'Dev team',
    p => p.from === 'Development team' && p.infra !== 'Deployment Completed' && p.infra !== 'Not started',
  ],
  [
    'esc',
    'Escalated',
    (p, s) => (p.from === 'Client' && p.step != null && p.step >= escIndex(s)) || (p.ifu || []).length >= s.iladder.length,
  ],
  ['moved', 'Rescheduled', p => !!p.moved],
]

/* ───────────── Field options ───────────── */

export const PRIOS = ['Critical', 'High', 'Medium', 'Low', 'Not set']
export const FROMS = ['Client', 'Development team', 'DevOps', 'Not set']
export const DEPLOYS = ['Waiting', 'In progress', 'Completed', 'Not set']
export const DEP_TYPES = ['ALSO', 'Client environment', 'Not set']

export type FieldKey = 'infra' | 'prio' | 'from' | 'act' | 'deploy' | 'depType' | 'dev' | 'owner' | 'devOwner'

export const FIELD_LABEL: Record<FieldKey, string> = {
  infra: 'Status',
  prio: 'Priority',
  from: 'Action from',
  act: 'Action status',
  deploy: 'Deployment status',
  depType: 'Deployment type',
  dev: 'Dev phase',
  owner: 'DevOps owner',
  devOwner: 'Dev phase owner',
}

/** The DevOps team for owner pickers: Settings' list, plus the signed-in person when they are not on it. */
export const teamOf = (s: DvSettings, me?: string) => (me && !s.people.includes(me) ? [...s.people, me] : s.people)

/** The options of a Details dropdown for this project. */
export const fieldOptions = (k: FieldKey, p: DvProject, s: DvSettings, me?: string): string[] => {
  const extra = s.options[k] || []
  switch (k) {
    case 'infra':
      return s.statuses.map(x => x.name)
    case 'prio':
      return [...PRIOS, ...extra]
    case 'from':
      return [...FROMS, ...extra]
    case 'act':
      return [...lad(p, s), 'Not required']
    case 'deploy':
      return [...DEPLOYS, ...extra]
    case 'depType':
      return [...DEP_TYPES, ...extra]
    case 'dev':
      return [...devListFor(p, s), 'Not set']
    case 'owner':
    case 'devOwner':
      return [...teamOf(s, me), ...extra, 'Unassigned']
  }
}

/** The value a dropdown shows (unknown values fall back to the last option, e.g. "Not set"). */
export const fieldValue = (k: FieldKey, p: DvProject, s: DvSettings, me?: string) => {
  const raw = k === 'owner' || k === 'devOwner' ? p[k] || 'Unassigned' : (p[k] as string | undefined)
  const opts = fieldOptions(k, p, s, me)
  return raw && opts.includes(raw) ? raw : opts[opts.length - 1]
}
