import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';

/**
 * S-LEAVESHEET New request sheet. No params (SheetParams['leave'] in src/nav/routes.ts).
 * Placeholder: P2 replaces this file (src/app/(app)/sheet/leave.tsx) and renders <BottomSheet>.
 */
export default function LeaveSheet() {
  const params = useLocalSearchParams();
  return (
    <PlaceholderSheet
      screen="S-LEAVESHEET"
      title="New request"
      owner="P2"
      file="src/app/(app)/sheet/leave.tsx"
      params={params}
      testID="sheet-leave"
    />
  );
}
