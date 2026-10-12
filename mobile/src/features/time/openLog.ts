import { showToast } from '@/components/Toast';
import { myCan } from '@/data/selectors';
import { store } from '@/data/store';
import { openSheet, type SheetParams } from '@/nav/routes';

/**
 * Open SH-LOG for everyone (V-10). Embed placeholder owned by W3: until W3 lands it
 * opens the placeholder `log-time` sheet. Roles without Timesheet access get the toast
 * "Your role does not log time" instead of the sheet.
 *
 *   openLog()                                     // empty (Dashboard "Log your time")
 *   openLog({ date: '2026-10-08' })               // Timesheet Log for a day
 *   openLog({ proj: 'c:dacop', key: 'PMT-11' })   // ticket Time "Log"
 *   openLog({ proj: 'c:dacop', key: 'PMT-11.s2' })// subtask (stable id)
 *   openLog({ proj: 'c:fjp', text: 'Backup restore test' }) // Support upkeep
 *   openLog({ id: 7 })                            // edit an entry
 */
export function openLog(preset?: SheetParams['log-time']): void {
  if (!myCan(store.getState(), 'Timesheet')) {
    showToast('Your role does not log time');
    return;
  }
  openSheet('log-time', preset);
}
