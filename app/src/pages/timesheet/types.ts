/** Work types a time entry can have (the Tickets Timesheet's Type list). */
export const ETYPES = ['General', 'Meeting', 'Review', 'DevOps'] as const

/** [ink, soft, dot] per work type, as in the Tickets Timesheet. */
export const ETYPE_COLOURS: Record<string, [string, string, string]> = {
  DevOps: ['#3F2E94', '#E6DFFA', '#9F89E5'],
  General: ['#3F2E94', '#E6DFFA', '#9F89E5'],
  Meeting: ['#7A5C0E', '#FBEDC2', '#B98A2F'],
  Review: ['#1F6F6E', '#DFF1F0', '#3E908F'],
}
