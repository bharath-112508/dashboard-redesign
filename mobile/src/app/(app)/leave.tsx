import { Placeholder } from '@/components/Placeholder';
import { capabilities, me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { openSheet } from '@/nav/routes';

/**
 * S-LEAVE Leave & comp-off ("+ New" for everyone except freelancers).
 * Placeholder: P2 replaces this file (src/app/(app)/leave.tsx).
 */
export default function LeaveScreen() {
  const role = useAppState((s) => me(s)?.role);
  const canNew = !!role && capabilities(role).hasLeave;
  return (
    <Placeholder
      screen="S-LEAVE"
      title="Leave & comp-off"
      owner="P2"
      file="src/app/(app)/leave.tsx"
      action={canNew ? { label: '+ New', onPress: () => openSheet('leave'), testID: 'action-new-leave' } : undefined}
      testID="screen-leave"
    />
  );
}
