import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-SUPREQ Report a problem / Request a change (URL sheet `support-request`) — placeholder; W2 replaces this body. */
export default function SupportRequestSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'support-request'>>();
  return <PlaceholderSheet spec="SH-SUPREQ Report a problem / Request a change" owner="W2" title="Support request" id="support-request" params={params} />;
}
