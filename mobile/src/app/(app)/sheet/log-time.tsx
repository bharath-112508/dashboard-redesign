import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-LOG Log your time (URL sheet `log-time`) — placeholder; W3 replaces this body. */
export default function LogTimeSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'log-time'>>();
  return <PlaceholderSheet spec="SH-LOG Log your time" owner="W3" title="Log your time" id="log-time" params={params} />;
}
