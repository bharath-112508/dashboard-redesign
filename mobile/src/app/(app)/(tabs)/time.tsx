import { PlaceholderScreen } from '@/components/Placeholder';
import { useRootActions } from '@/nav/useRootActions';

/** S5-TIME Timesheet — placeholder; W3 replaces this body. */
export default function TimeTab() {
  const actions = useRootActions();
  return <PlaceholderScreen spec="S5-TIME Timesheet" owner="W3" title="My timesheet" id="time" actions={actions} />;
}
