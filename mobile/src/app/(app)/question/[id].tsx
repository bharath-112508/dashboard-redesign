import { useLocalSearchParams } from 'expo-router';

import { QuestionScreen } from '@/features/client/QuestionScreen';

/** S5-QUESTION Question. */
export default function QuestionRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <QuestionScreen key={id} id={id ?? ''} />;
}
