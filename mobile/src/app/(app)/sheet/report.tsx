import { useLocalSearchParams } from 'expo-router';

import { ReportSheet } from '@/features/client/ReportSheet';
import type { SheetParams } from '@/nav/routes';

/** S-BUG Report a problem / Request a change. Params: SheetParams['report'] (strings in the URL). */
export default function ReportSheetRoute() {
  const { project, kind } = useLocalSearchParams<{ [K in keyof SheetParams['report']]?: string }>();
  return <ReportSheet project={project || undefined} kind={kind === 'Change' ? 'Change' : 'Bug'} />;
}
