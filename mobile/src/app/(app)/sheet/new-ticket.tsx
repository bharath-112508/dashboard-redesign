import { useLocalSearchParams } from 'expo-router';

import { NewTicketSheet } from '@/features/tickets/NewTicketSheet';
import type { SheetQuery } from '@/nav/routes';

/** SH-NEWTICKET Create ticket (URL sheet `new-ticket`, `{pid}`). */
export default function NewTicketSheetRoute() {
  const { pid } = useLocalSearchParams<SheetQuery<'new-ticket'>>();
  return <NewTicketSheet pid={String(pid ?? '')} />;
}
