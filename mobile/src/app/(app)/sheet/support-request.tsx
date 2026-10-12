import { useLocalSearchParams } from 'expo-router';

import { SupportRequestSheet } from '@/features/projects/sheets/SupportRequestSheet';
import type { SheetQuery } from '@/nav/routes';

/** SH-SUPREQ Report a problem / Request a change (URL sheet `support-request`, `{pid, kind}`). */
export default function SupportRequestSheetRoute() {
  const { pid, kind } = useLocalSearchParams<SheetQuery<'support-request'>>();
  return <SupportRequestSheet pid={pid ?? ''} kind={kind === 'change' ? 'change' : 'problem'} />;
}
