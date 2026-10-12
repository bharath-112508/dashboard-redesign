import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '@/components/Placeholder';

/**
 * S-QUESTION Question detail (no tab bar; composer).
 * Placeholder: P4 replaces this file (src/app/(app)/question/[id].tsx).
 */
export default function QuestionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <Placeholder
      screen="S-QUESTION"
      title="Question"
      owner="P4"
      file="src/app/(app)/question/[id].tsx"
      noTabBar
      params={{ id }}
      testID="screen-question"
    />
  );
}
