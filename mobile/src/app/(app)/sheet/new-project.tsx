import { useLocalSearchParams } from 'expo-router';

import { NewProjectSheet } from '@/features/projects/sheets/NewProjectSheet';
import type { SheetQuery } from '@/nav/routes';

/** SH-NEWPROJECT Start a project (URL sheet `new-project`, `{co?}`). */
export default function NewProjectSheetRoute() {
  const { co } = useLocalSearchParams<SheetQuery<'new-project'>>();
  return <NewProjectSheet co={co || undefined} />;
}
