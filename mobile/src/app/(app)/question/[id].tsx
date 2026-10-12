import { useLocalSearchParams } from 'expo-router';

import { PlaceholderScreen } from '@/components/Placeholder';

/** S5-QUESTION Question — placeholder; W4 replaces this body. */
export default function QuestionRoute() {
  const params = useLocalSearchParams<{ id?: string }>();
  return <PlaceholderScreen spec="S5-QUESTION Question" owner="W4" title="Question" id="question" params={params} />;
}
