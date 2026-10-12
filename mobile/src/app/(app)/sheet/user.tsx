import { useLocalSearchParams } from 'expo-router';

import { UserSheet } from '@/features/admin/UserSheet';
import type { SheetQuery } from '@/nav/routes';

/** URL sheet `user` (W3). */
export default function UserSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'user'>>();
  return <UserSheet params={params} />;
}
