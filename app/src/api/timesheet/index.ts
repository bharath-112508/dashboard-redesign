/** Public surface of the shared time model. Import from here, not from the files inside. */
export { logTime, type NewTimeEntry, type TimeCommand } from './commands'
export { TARGET_DAY, weekStart, weekDays, fmtHours, toHours, entryHours } from './week'
export { entryProject, projectOptions, findProject, ticketOptions, taskLabel, type ProjectOption } from './projects'
