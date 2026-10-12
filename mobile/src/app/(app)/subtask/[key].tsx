import { useLocalSearchParams } from 'expo-router';

import { SubtaskScreen } from '@/features/tickets/SubtaskScreen';

/** S5-SUB Subtask (`/subtask/PMT-11.s2`, the stable subtask id, A-11). */
export default function SubtaskRoute() {
  const { key } = useLocalSearchParams<{ key?: string }>();
  return <SubtaskScreen subId={String(key ?? '')} />;
}
