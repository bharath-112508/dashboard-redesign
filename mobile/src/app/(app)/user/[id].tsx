import { useLocalSearchParams } from 'expo-router';

import { PlaceholderScreen } from '@/components/Placeholder';

/** S5-USER User — placeholder; W3 replaces this body. */
export default function UserRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  return <PlaceholderScreen spec="S5-USER User" owner="W3" title="User" id="user" params={params} />;
}
