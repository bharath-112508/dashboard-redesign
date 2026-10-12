import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-LEAVE Add leave (URL sheet `leave`) — placeholder; W3 replaces this body. */
export default function LeaveSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'leave'>>();
  return <PlaceholderSheet spec="SH-LEAVE Add leave" owner="W3" title="Add leave" id="leave" params={params} />;
}
