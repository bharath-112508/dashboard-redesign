import { useLocalSearchParams } from 'expo-router';

import { ClientMemberSheet } from '@/features/client/ClientMemberSheet';
import type { SheetQuery } from '@/nav/routes';

/** SH-CMEMBER Team member (URL sheet `client-member`). */
export default function ClientMemberSheetRoute() {
  const { email } = useLocalSearchParams<SheetQuery<'client-member'>>();
  return <ClientMemberSheet email={email} />;
}
