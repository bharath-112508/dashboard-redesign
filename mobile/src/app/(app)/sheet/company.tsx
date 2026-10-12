import { useLocalSearchParams } from 'expo-router';

import { PlaceholderSheet } from '@/components/Placeholder';
import type { SheetQuery } from '@/nav/routes';

/** SH-COMPANY Add or edit company (URL sheet `company`) — placeholder; W3 replaces this body. */
export default function CompanySheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'company'>>();
  return <PlaceholderSheet spec="SH-COMPANY Add or edit company" owner="W3" title="Add a company" id="company" params={params} />;
}
