import { useLocalSearchParams } from 'expo-router';

import { PlaceholderScreen } from '@/components/Placeholder';

/** S5-PORTAL Project portal (staff view) — placeholder; W4 replaces this body. */
export default function PortalRoute() {
  const params = useLocalSearchParams<{ co?: string }>();
  return <PlaceholderScreen spec="S5-PORTAL Project portal (staff view)" owner="W4" title="Project portal" id="portal" sub="Client portal" params={params} />;
}
