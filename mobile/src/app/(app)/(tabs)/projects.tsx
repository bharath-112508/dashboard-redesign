import { isClient } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { PortalScreen } from '@/features/client/PortalScreen';
import { ProjectsScreen } from '@/features/projects/ProjectsScreen';

/** Projects tab: staff S5-PROJECTS (W2); clients get the portal (W4's PortalScreen embed). */
export default function ProjectsTab() {
  const client = useAppState(isClient);
  return client ? <PortalScreen /> : <ProjectsScreen />;
}
