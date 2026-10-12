import { useLocalSearchParams } from 'expo-router';

import { ProjectScreen } from '@/features/projects/ProjectScreen';

/** S5-PROJECT (`?tab=`). */
export default function ProjectRoute() {
  const { id, tab } = useLocalSearchParams<{ id?: string; tab?: string }>();
  return <ProjectScreen key={id} id={id ?? ''} tab={tab} />;
}
