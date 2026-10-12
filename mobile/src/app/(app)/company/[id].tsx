import { useLocalSearchParams } from 'expo-router';

import { PlaceholderScreen } from '@/components/Placeholder';

/** S5-COMPANY Company — placeholder; W3 replaces this body. */
export default function CompanyRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  return <PlaceholderScreen spec="S5-COMPANY Company" owner="W3" title="Company" id="company" params={params} />;
}
