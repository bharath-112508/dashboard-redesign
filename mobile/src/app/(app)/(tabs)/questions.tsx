import { Placeholder } from '@/components/Placeholder';
import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { tabTitle } from '@/nav/titles';

/**
 * S-QUESTIONS (tab root, large header).
 * Placeholder: P4 replaces this file (src/app/(app)/(tabs)/questions.tsx).
 */
export default function QuestionsTab() {
  const role = useAppState((s) => me(s)?.role ?? 'dev');
  return (
    <Placeholder
      screen="S-QUESTIONS"
      title={tabTitle('questions', role)}
      owner="P4"
      file="src/app/(app)/(tabs)/questions.tsx"
      header="large"
      testID="screen-questions"
    />
  );
}
