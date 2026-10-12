import { PlaceholderScreen } from '@/components/Placeholder';
import { isClient, myPerm } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { PortalScreen } from '@/features/client/PortalScreen';
import { openSheet } from '@/nav/routes';
import { useRootActions } from '@/nav/useRootActions';

/**
 * Projects tab: staff S5-PROJECTS (W2 replaces the staff branch); clients get the
 * portal (W4's PortalScreen embed).
 */
export default function ProjectsTab() {
  const client = useAppState(isClient);
  const canCreate = useAppState((s) => myPerm(s, 'projects.create'));
  const root = useRootActions();
  if (client) return <PortalScreen />;
  const actions = canCreate ? [{ icon: 'plus' as const, label: 'New project', onPress: () => openSheet('new-project'), testID: 'header-new-project' }, ...root] : root;
  return <PlaceholderScreen spec="S5-PROJECTS Projects" owner="W2" title="Projects" id="projects" actions={actions} />;
}
