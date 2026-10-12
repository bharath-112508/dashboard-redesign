import { useLocalSearchParams } from 'expo-router';

import { CompanyTimeScreen } from '@/features/time/EmpScreen';

/** S5-COTS Company timesheets (`?pf=c:<project>`, W3). */
export default function CompanyTimeRoute() {
  const { id, pf } = useLocalSearchParams<{ id: string; pf?: string }>();
  return <CompanyTimeScreen key={`${id}|${pf ?? ''}`} id={id ?? ''} pf={pf} />;
}
