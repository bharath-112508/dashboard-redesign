import { PlaceholderScreen } from '@/components/Placeholder';
import { useRootActions } from '@/nav/useRootActions';

/** S5-DEVOPS DevOps board — placeholder; W4 replaces this body. */
export default function DevopsTab() {
  const actions = useRootActions();
  return <PlaceholderScreen spec="S5-DEVOPS DevOps board" owner="W4" title="DevOps board" id="devops" actions={actions} />;
}
