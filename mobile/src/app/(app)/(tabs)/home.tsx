import { Button } from '@/components/Buttons';
import { PlaceholderScreen } from '@/components/Placeholder';
import { me, myCan } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { openLog } from '@/features/time/openLog';
import { DASH_SCOPE } from '@/nav/titles';
import { useRootActions } from '@/nav/useRootActions';

/** S5-DASH Dashboard (all roles) — placeholder; W1 replaces this body. */
export default function HomeTab() {
  const role = useAppState((s) => me(s)?.role ?? 'dev');
  const canLog = useAppState((s) => myCan(s, 'Timesheet'));
  const actions = useRootActions();
  return (
    <PlaceholderScreen spec="S5-DASH Dashboard" owner="W1" title="Dashboard" sub={DASH_SCOPE[role]} id="home" actions={actions}>
      {canLog ? <Button title="Log your time" icon="timer" onPress={() => openLog()} testID="dash-log-time" /> : null}
    </PlaceholderScreen>
  );
}
