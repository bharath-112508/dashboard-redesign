import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-NEWPROJECT Start a project (URL sheet `new-project`) — placeholder; W2 replaces this body. */
export default function NewProjectSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'new-project'>>();
  return <PlaceholderSheet spec="SH-NEWPROJECT Start a project" owner="W2" title="Start a project" id="new-project" params={params} />;
}
