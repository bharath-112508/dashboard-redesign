import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-CONTACT Client contact (URL sheet `contact`) — placeholder; W3 replaces this body. */
export default function ContactSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'contact'>>();
  return <PlaceholderSheet spec="SH-CONTACT Client contact" owner="W3" title="Add a contact" id="contact" params={params} />;
}
