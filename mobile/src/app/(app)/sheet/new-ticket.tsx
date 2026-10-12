import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-NEWTICKET Create ticket (URL sheet `new-ticket`) — placeholder; W1 replaces this body. */
export default function NewTicketSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'new-ticket'>>();
  return <PlaceholderSheet spec="SH-NEWTICKET Create ticket" owner="W1" title="Create ticket" id="new-ticket" params={params} />;
}
