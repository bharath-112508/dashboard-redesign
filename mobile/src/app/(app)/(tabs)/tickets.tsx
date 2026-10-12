import { Placeholder } from '@/components/Placeholder';
import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { tabTitle } from '@/nav/titles';

/**
 * S-TICKETS (tab root, large header).
 * Placeholder: P1 replaces this file (src/app/(app)/(tabs)/tickets.tsx).
 */
export default function TicketsTab() {
  const role = useAppState((s) => me(s)?.role ?? 'dev');
  return (
    <Placeholder
      screen="S-TICKETS"
      title={tabTitle('tickets', role)}
      owner="P1"
      file="src/app/(app)/(tabs)/tickets.tsx"
      header="large"
      testID="screen-tickets"
    />
  );
}
