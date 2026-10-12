import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-CMEMBER Team member (URL sheet `client-member`) — placeholder; W4 replaces this body. */
export default function ClientMemberSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'client-member'>>();
  return <PlaceholderSheet spec="SH-CMEMBER Team member" owner="W4" title="Add someone from your team" id="client-member" params={params} />;
}
