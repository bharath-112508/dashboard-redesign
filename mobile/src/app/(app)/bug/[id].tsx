import { useLocalSearchParams } from 'expo-router';

import { BugScreen } from '@/features/client/BugScreen';

/** S5-BUG Bug. */
export default function BugRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <BugScreen id={id ?? ''} />;
}
