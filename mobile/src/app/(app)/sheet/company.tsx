import { useLocalSearchParams } from 'expo-router';

import { CompanySheet } from '@/features/admin/CompanySheet';
import type { SheetQuery } from '@/nav/routes';

/** URL sheet `company` (W3). */
export default function CompanySheetRoute() {
  const params = useLocalSearchParams<SheetQuery<'company'>>();
  return <CompanySheet params={params} />;
}
