import { PlaceholderScreen } from '@/components/Placeholder';
import { useRootActions } from '@/nav/useRootActions';

/** S5-BUGS Bugs — placeholder; W4 replaces this body. */
export default function BugsTab() {
  const actions = useRootActions();
  return <PlaceholderScreen spec="S5-BUGS Bugs" owner="W4" title="Bugs" id="bugs" actions={actions} />;
}
