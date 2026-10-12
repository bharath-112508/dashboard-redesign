import { useLocalSearchParams } from 'expo-router';

import { RequestScreen } from '@/features/devops/RequestScreen';

/** S5-REQ DevOps request. */
export default function DevopsRequestRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <RequestScreen id={id ?? ''} />;
}
