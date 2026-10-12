import { Placeholder } from '@/components/Placeholder';
import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { tabTitle } from '@/nav/titles';

/**
 * S-DEVOPS (tab root, large header).
 * Placeholder: P4 replaces this file (src/app/(app)/(tabs)/devops.tsx).
 */
export default function DevopsTab() {
  const role = useAppState((s) => me(s)?.role ?? 'dev');
  return (
    <Placeholder
      screen="S-DEVOPS"
      title={tabTitle('devops', role)}
      owner="P4"
      file="src/app/(app)/(tabs)/devops.tsx"
      header="large"
      testID="screen-devops"
    />
  );
}
