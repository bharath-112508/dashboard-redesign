import { Placeholder } from '@/components/Placeholder';
import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { openSheet } from '@/nav/routes';
import { tabTitle } from '@/nav/titles';

/**
 * S-TIME (tab root, large header).
 * Placeholder: P2 replaces this file (src/app/(app)/(tabs)/time.tsx).
 */
export default function TimeTab() {
  const role = useAppState((s) => me(s)?.role ?? 'dev');
  return (
    <Placeholder
      screen="S-TIME"
      title={tabTitle('time', role)}
      owner="P2"
      file="src/app/(app)/(tabs)/time.tsx"
      header="large"
      action={{ label: 'Log', onPress: () => openSheet('log-time'), testID: 'action-log' }}
      testID="screen-time"
    />
  );
}
