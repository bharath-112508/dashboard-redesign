import { useLocalSearchParams } from 'expo-router';

import { PlaceholderScreen } from '@/components/Placeholder';

/** S5-COTS Company timesheets — placeholder; W3 replaces this body. */
export default function CompanyTimeRoute() {
  const params = useLocalSearchParams<{ id?: string; pf?: string }>();
  return <PlaceholderScreen spec="S5-COTS Company timesheets" owner="W3" title="Timesheets" id="company-time" params={params} />;
}
