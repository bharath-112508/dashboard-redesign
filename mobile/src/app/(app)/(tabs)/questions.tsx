import { PlaceholderScreen } from '@/components/Placeholder';
import { useRootActions } from '@/nav/useRootActions';

/** S5-QUESTIONS Questions — placeholder; W4 replaces this body. */
export default function QuestionsTab() {
  const actions = useRootActions();
  return <PlaceholderScreen spec="S5-QUESTIONS Questions" owner="W4" title="Questions" id="questions" sub="From the Viljetech team" actions={actions} />;
}
