import { useLocalSearchParams } from 'expo-router';

import { ContactSheet } from '@/features/admin/ContactSheet';
import type { SheetQuery } from '@/nav/routes';

/** URL sheet `contact` (W3). */
export default function ContactSheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'contact'>>();
  return <ContactSheet params={params} />;
}
