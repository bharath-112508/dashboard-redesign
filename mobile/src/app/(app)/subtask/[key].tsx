import { useLocalSearchParams } from 'expo-router';

import { PlaceholderScreen } from '@/components/Placeholder';

/** S5-SUB Subtask — placeholder; W1 replaces this body. */
export default function SubtaskRoute() {
  const params = useLocalSearchParams<{ key?: string }>();
  return <PlaceholderScreen spec="S5-SUB Subtask" owner="W1" title="Subtask" id="subtask" params={params} />;
}
