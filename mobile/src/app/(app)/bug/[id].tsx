import { useLocalSearchParams } from 'expo-router';

import { PlaceholderScreen } from '@/components/Placeholder';

/** S5-BUG Bug — placeholder; W4 replaces this body. */
export default function BugRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  return <PlaceholderScreen spec="S5-BUG Bug" owner="W4" title="Bug" id="bug" params={params} />;
}
