import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-NEWBUG Report a bug (URL sheet `report-bug`) — placeholder; W4 replaces this body. */
export default function ReportBugSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'report-bug'>>();
  return <PlaceholderSheet spec="SH-NEWBUG Report a bug" owner="W4" title="Report a bug" id="report-bug" params={params} />;
}
