import { useLocalSearchParams } from 'expo-router';

import { ProjectScreen } from '@/features/projects/ProjectScreen';

/** S-PROJECT Project detail (all views). Title is the project name. */
export default function ProjectRoute() {
  const { name = '' } = useLocalSearchParams<{ name: string }>();
  return <ProjectScreen name={name} />;
}
