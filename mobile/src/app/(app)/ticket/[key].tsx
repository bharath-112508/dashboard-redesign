import { useLocalSearchParams } from 'expo-router';

import { PlaceholderScreen } from '@/components/Placeholder';

/** S5-TICKET Ticket — placeholder; W1 replaces this body. */
export default function TicketRoute() {
  const params = useLocalSearchParams<{ key?: string }>();
  return <PlaceholderScreen spec="S5-TICKET Ticket" owner="W1" title="Ticket" id="ticket" params={params} />;
}
