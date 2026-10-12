import { Placeholder } from '@/components/Placeholder';
import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { tabTitle } from '@/nav/titles';

/**
 * S-PROJECTS (tab root, large header).
 * Placeholder: P3 replaces this file (src/app/(app)/(tabs)/projects.tsx).
 */
export default function ProjectsTab() {
  const role = useAppState((s) => me(s)?.role ?? 'dev');
  return (
    <Placeholder
      screen="S-PROJECTS"
      title={tabTitle('projects', role)}
      owner="P3"
      file="src/app/(app)/(tabs)/projects.tsx"
      header="large"
      testID="screen-projects"
    />
  );
}
