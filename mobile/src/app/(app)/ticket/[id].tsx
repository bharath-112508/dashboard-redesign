import { useLocalSearchParams } from 'expo-router';

import { TicketDetailScreen } from '@/features/tickets/TicketDetailScreen';

/** S-TICKET Ticket detail (no tab bar; composer). */
export default function TicketScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <TicketDetailScreen key={id} id={Number(id)} />;
}
