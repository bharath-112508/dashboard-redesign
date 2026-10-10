import type { DvSettings } from './types'

/**
 * The client ladder index from which a project counts as escalated. It is
 * found by step name, so renaming, reordering or removing steps in Settings
 * keeps escalation on the same step. `esc` (an index) is the fallback for
 * data saved before the name was stored.
 */
export const escalationIndex = (s: Pick<DvSettings, 'ladder' | 'rules'>): number => {
  const names = s.ladder.map(x => x.name)
  const byName = s.rules.escStep ? names.indexOf(s.rules.escStep) : -1
  if (byName >= 0) return byName
  return Math.max(0, Math.min(s.rules.esc, names.length - 1))
}
