import { Placeholder } from '@/components/Placeholder';
import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { openSheet } from '@/nav/routes';
import { tabTitle } from '@/nav/titles';

/**
 * S-BUGS (tab root, large header).
 * Placeholder: P4 replaces this file (src/app/(app)/(tabs)/bugs.tsx).
 */
export default function BugsTab() {
  const role = useAppState((s) => me(s)?.role ?? 'dev');
  return (
    <Placeholder
      screen="S-BUGS"
      title={tabTitle('bugs', role)}
      owner="P4"
      file="src/app/(app)/(tabs)/bugs.tsx"
      header="large"
      action={{ label: 'Report', onPress: () => openSheet('report'), testID: 'action-report' }}
      testID="screen-bugs"
    />
  );
}
