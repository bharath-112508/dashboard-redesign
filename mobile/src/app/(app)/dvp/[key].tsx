import { useLocalSearchParams } from 'expo-router';

import { PlaceholderScreen } from '@/components/Placeholder';

/** S5-DVP DevOps project — placeholder; W4 replaces this body. */
export default function DevopsProjectRoute() {
  const params = useLocalSearchParams<{ key?: string; tab?: string }>();
  return <PlaceholderScreen spec="S5-DVP DevOps project" owner="W4" title="DevOps project" id="dvp" params={params} />;
}
