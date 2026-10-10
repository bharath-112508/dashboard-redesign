import type { DvProject, DvSettings } from '../../api/devops/types'
import { ddMon, dayOf, escIndex, fmtD, lad, relD, shortD } from './model'

/** What the list row and the board card show for a project (the prototype's `deco`). */
export const projectView = (p: DvProject, s: DvSettings) => {
  const L = lad(p, s)
  const esc = escIndex(s)
  const crit = p.prio === 'Critical'
  const onLadder = p.from === 'Client' && p.step != null && p.infra !== 'Not started'
  const f = p.ifu || []
  const di = dayOf(p.latestDue || p.initDue)
  const notStartedAdded = p.infra === 'Not started' && !!p.added
  const [dr, dc] = relD(di, p.deploy !== 'Completed')
  const nx = p.step != null ? L[Math.min(p.step + 1, L.length - 1)] : null
  const [rr] = relD(dayOf(p.reminder), true)
  const hot = p.step != null && p.step >= esc

  return {
    crit,
    onLadder,
    ladderLabel: p.step != null ? L[p.step] + ' · ' + (p.step + 1) + '/' + L.length : '',
    stepC: hot ? '#A5502C' : '#0062cc',
    dots: L.map((_, i) => (p.step != null && i <= p.step ? (hot ? '#D2724A' : '#4870E8') : '#E4EAF0')),
    fuText: onLadder
      ? ''
      : notStartedAdded
        ? 'Added ' + ddMon(p.added)
        : p.from === 'Client' && p.infra === 'Not started'
          ? 'Starts at onboarding'
          : f.length
            ? s.iladder[f.length - 1] + ' · ' + ddMon(f[f.length - 1].date)
            : p.act,
    fuC: notStartedAdded && !di ? '#1B2D45' : '#56657A',
    fuSub: notStartedAdded && !di ? relD(p.added, false)[0] : '',
    remShort: p.reminder ? nx || shortD(p.reminder) : '—',
    remValC: p.reminder ? (p.overdue ? '#A5502C' : '#1B2D45') : '#A9B6C5',
    remRel: p.reminder ? (p.overdue ? 'Overdue ' + rr.replace(' ago', '') : rr) : '',
    remRelC: p.overdue ? '#A5502C' : '#3B4A5E',
    remTitle: fmtD(p.reminder),
    lDue: di ? shortD(di) : '—',
    lDueC: di ? '#1B2D45' : '#A9B6C5',
    lDueRel: di ? (p.moved && p.latestDue ? 'Moved ' + p.moved : dr) : '',
    dueRelC: p.moved && p.latestDue ? '#7A5C0E' : dc,
    dueTitle: fmtD(p.latestDue || p.initDue) + (p.moved && p.latestDue ? ' · initial ' + fmtD(p.initDue) : ''),
    dueShort: di ? 'Due ' + ddMon(di) : notStartedAdded ? 'Added ' + ddMon(p.added) : 'No due date',
    phaseShort: p.phase || p.next || 'No notes',
    rowBg: crit ? '#FBF3EF' : '#fff',
    hoverBg: crit ? '#F6DDD0' : '#F6F9FC',
    accent: crit ? '#D2724A' : 'transparent',
  }
}
