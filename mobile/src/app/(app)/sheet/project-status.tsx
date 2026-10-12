import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetParams } from '@/nav/routes';

/**
 * S-PSS Project status sheet. Params (strings in the URL): SheetParams['project-status'] in src/nav/routes.ts.
 * Placeholder: P3 replaces this file (src/app/(app)/sheet/project-status.tsx) and renders <BottomSheet>.
 */
export default function ProjectStatusSheet() {
  const params = useLocalSearchParams<{ [K in keyof SheetParams['project-status']]?: string }>();
  return (
    <PlaceholderSheet
      screen="S-PSS"
      title="Project status"
      owner="P3"
      file="src/app/(app)/sheet/project-status.tsx"
      params={params}
      testID="sheet-project-status"
    />
  );
}
