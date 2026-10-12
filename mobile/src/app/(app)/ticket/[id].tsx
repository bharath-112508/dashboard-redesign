import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '@/components/Placeholder';
import { ticketById } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { sheetHref } from '@/nav/routes';

/**
 * S-TICKET Ticket detail (no tab bar; composer). Title is the ticket key.
 * Placeholder: P1 replaces this file (src/app/(app)/ticket/[id].tsx).
 */
export default function TicketScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const ticket = useAppState((s) => ticketById(s, Number(id)));
  return (
    <Placeholder
      screen="S-TICKET"
      title={ticket?.key ?? 'Ticket'}
      owner="P1"
      file="src/app/(app)/ticket/[id].tsx"
      noTabBar
      params={{ id }}
      links={[{ label: 'Log time on this ticket', href: sheetHref('log-time', { ticketId: Number(id) }) }]}
      testID="screen-ticket"
    />
  );
}
