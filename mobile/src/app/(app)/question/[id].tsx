import { useLocalSearchParams } from 'expo-router';

import { QuestionScreen } from '@/features/client/QuestionScreen';

/** S-QUESTION Question detail (no tab bar; composer). */
export default function QuestionRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <QuestionScreen id={Number(id)} />;
}
