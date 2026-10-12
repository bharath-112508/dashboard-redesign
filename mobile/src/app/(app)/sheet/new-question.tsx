import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-NEWQ Raise to client (URL sheet `new-question`) — placeholder; W4 replaces this body. */
export default function NewQuestionSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'new-question'>>();
  return <PlaceholderSheet spec="SH-NEWQ Raise to client" owner="W4" title="Raise to client" id="new-question" params={params} />;
}
