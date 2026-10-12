import { PlaceholderScreen } from '@/components/Placeholder';
import { useRootActions } from '@/nav/useRootActions';

/** S5-MYTICKETS My tickets — placeholder; W1 replaces this body. */
export default function MyTicketsTab() {
  const actions = useRootActions();
  return <PlaceholderScreen spec="S5-MYTICKETS My tickets" owner="W1" title="My tickets" id="tickets" actions={actions} />;
}
