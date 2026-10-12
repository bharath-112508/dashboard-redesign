import { useLocalSearchParams } from 'expo-router';

import { LogTimeSheet } from '@/features/time/LogTimeSheet';
import type { SheetQuery } from '@/nav/routes';

/** URL sheet `log-time` (W3). */
export default function LogTimeSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'log-time'>>();
  return <LogTimeSheet params={params} />;
}
