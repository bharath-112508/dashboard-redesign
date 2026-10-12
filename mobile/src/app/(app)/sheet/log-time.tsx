import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetParams } from '@/nav/routes';

/**
 * S-LOG Log time sheet. Params (strings in the URL): SheetParams['log-time'] in src/nav/routes.ts.
 * Placeholder: P2 replaces this file (src/app/(app)/sheet/log-time.tsx) and renders <BottomSheet>.
 */
export default function LogTimeSheet() {
  const params = useLocalSearchParams<{ [K in keyof SheetParams['log-time']]?: string }>();
  return (
    <PlaceholderSheet
      screen="S-LOG"
      title="Log time"
      owner="P2"
      file="src/app/(app)/sheet/log-time.tsx"
      params={params}
      testID="sheet-log-time"
    />
  );
}
