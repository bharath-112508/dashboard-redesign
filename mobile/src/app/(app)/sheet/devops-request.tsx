import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-NEWREQ Send request (URL sheet `devops-request`) — placeholder; W4 replaces this body. */
export default function DevopsRequestSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'devops-request'>>();
  return <PlaceholderSheet spec="SH-NEWREQ Send request" owner="W4" title="Send request" id="devops-request" params={params} />;
}
