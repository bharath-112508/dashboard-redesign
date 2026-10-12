import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetParams } from '@/nav/routes';

/**
 * S-PLAN Set up maintenance sheet. Params (strings in the URL): SheetParams['support-plan'] in src/nav/routes.ts.
 * Placeholder: P3 replaces this file (src/app/(app)/sheet/support-plan.tsx) and renders <BottomSheet>.
 */
export default function SupportPlanSheet() {
  const params = useLocalSearchParams<{ [K in keyof SheetParams['support-plan']]?: string }>();
  return (
    <PlaceholderSheet
      screen="S-PLAN"
      title="Set up maintenance"
      owner="P3"
      file="src/app/(app)/sheet/support-plan.tsx"
      params={params}
      testID="sheet-support-plan"
    />
  );
}
