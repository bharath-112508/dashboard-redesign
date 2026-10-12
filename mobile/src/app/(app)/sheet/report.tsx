import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetParams } from '@/nav/routes';

/**
 * S-BUG Report a problem sheet. Params (strings in the URL): SheetParams['report'] in src/nav/routes.ts.
 * Placeholder: P4 replaces this file (src/app/(app)/sheet/report.tsx) and renders <BottomSheet>.
 */
export default function ReportSheet() {
  const params = useLocalSearchParams<{ [K in keyof SheetParams['report']]?: string }>();
  return (
    <PlaceholderSheet
      screen="S-BUG"
      title="Report a problem"
      owner="P4"
      file="src/app/(app)/sheet/report.tsx"
      params={params}
      testID="sheet-report"
    />
  );
}
