import { useLocalSearchParams } from 'expo-router';

import { CompanyScreen } from '@/features/admin/CompanyScreen';

/** S-COMPANY Company detail. Title is the company name. */
export default function CompanyRoute() {
  const { name = '' } = useLocalSearchParams<{ name: string }>();
  return <CompanyScreen name={name} />;
}
