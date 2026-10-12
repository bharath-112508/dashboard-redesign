import { useLocalSearchParams } from 'expo-router';

import { ReportBugSheet } from '@/features/client/ReportBugSheet';
import type { SheetQuery } from '@/nav/routes';

/** SH-NEWBUG Report a bug (URL sheet `report-bug`). */
export default function ReportBugSheetRoute() {
  const { pid } = useLocalSearchParams<SheetQuery<'report-bug'>>();
  return <ReportBugSheet pid={pid} />;
}
