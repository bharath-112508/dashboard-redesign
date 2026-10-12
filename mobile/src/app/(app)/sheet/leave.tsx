import { useLocalSearchParams } from 'expo-router';

import { LeaveSheet } from '@/features/leave/LeaveSheet';
import type { SheetQuery } from '@/nav/routes';

/** URL sheet `leave` (W3). */
export default function LeaveSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'leave'>>();
  return <LeaveSheet params={params} />;
}
