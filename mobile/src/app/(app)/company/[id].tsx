import { useLocalSearchParams } from 'expo-router';

import { CompanyScreen } from '@/features/admin/CompanyScreen';

/** S5-COMPANY Company (W3). */
export default function CompanyRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <CompanyScreen id={id ?? ''} />;
}
