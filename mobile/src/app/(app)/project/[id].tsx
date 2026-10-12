import { useLocalSearchParams } from 'expo-router';

import { PlaceholderScreen } from '@/components/Placeholder';

/** S5-PROJECT Project — placeholder; W2 replaces this body. */
export default function ProjectRoute() {
  const params = useLocalSearchParams<{ id?: string; tab?: string }>();
  return <PlaceholderScreen spec="S5-PROJECT Project" owner="W2" title="Project" id="project" params={params} />;
}
