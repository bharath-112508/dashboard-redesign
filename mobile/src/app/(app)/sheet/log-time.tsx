import { LogTimeSheet } from '@/features/time/LogTimeSheet';

/** S-LOG Log time sheet. Params: SheetParams['log-time'] (ticketId, day, project, text). */
export default function LogTimeRoute() {
  return <LogTimeSheet />;
}
