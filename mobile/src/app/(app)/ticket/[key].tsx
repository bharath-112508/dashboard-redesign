import { useLocalSearchParams } from 'expo-router';

import { TicketScreen } from '@/features/tickets/TicketScreen';

/** S5-TICKET Ticket (`/ticket/PMT-11`). */
export default function TicketRoute() {
  const { key } = useLocalSearchParams<{ key?: string }>();
  return <TicketScreen ticketKey={String(key ?? '')} />;
}
