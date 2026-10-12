import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-USER Add or edit user (URL sheet `user`) — placeholder; W3 replaces this body. */
export default function UserSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'user'>>();
  return <PlaceholderSheet spec="SH-USER Add or edit user" owner="W3" title="Add user" id="user" params={params} />;
}
