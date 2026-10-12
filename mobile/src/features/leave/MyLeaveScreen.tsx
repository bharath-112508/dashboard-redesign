import { Button } from '@/components/Buttons';
import { Block } from '@/components/Card';
import { KpiGrid } from '@/components/KpiGrid';
import { Screen } from '@/components/Screen';
import { ANNUAL_LEAVE_DAYS } from '@/data/constants';
import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { openSheet } from '@/nav/routes';
import { colors } from '@/theme';

import { annualLeft, splitLeave } from './leave';
import { LeaveRows } from './LeaveRows';

/**
 * "My leave" (A-2): the signed-in person's balance and requests, with "Add leave"
 * (a pending request unless they can approve leave).
 */
export function MyLeaveScreen() {
  const u = useAppState(me);
  const leaves = useAppState((s) => s.leaves);
  const name = u?.name ?? '';
  const mine = leaves.filter((l) => l.who === name);
  const { pending, decided } = splitLeave(mine);
  const left = annualLeft(leaves, name);
  return (
    <Screen title="My leave" sub="Your balance and requests" testID="screen-leave">
      <KpiGrid
        items={[
          { label: 'Annual leave left', value: `${left} days`, sub: `of ${ANNUAL_LEAVE_DAYS} this year`, dot: colors.primary, testID: 'kpi-annual-left' },
          { label: 'Waiting for approval', value: String(pending.length), sub: pending.length === 1 ? 'request' : 'requests', dot: colors.amberDot, testID: 'kpi-pending' },
        ]}
      />
      <Button title="Add leave" icon="calendar-plus" onPress={() => openSheet('leave')} testID="my-leave-add" />
      <Block title="Requests" sub={pending.length ? `${pending.length} waiting for approval` : ''}>
        <LeaveRows items={pending} empty="No pending requests." testID="my-leave-pending" />
      </Block>
      <Block title="Decided">
        <LeaveRows items={decided} empty="Nothing decided yet." testID="my-leave-decided" />
      </Block>
    </Screen>
  );
}
