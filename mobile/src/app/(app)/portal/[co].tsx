import { useLocalSearchParams } from 'expo-router';

import { PortalScreen } from '@/features/client/PortalScreen';

/** S5-PORTAL Project portal (staff view of a client's portal). */
export default function PortalRoute() {
  const { co } = useLocalSearchParams<{ co?: string }>();
  return <PortalScreen co={co ?? 'daco'} />;
}
