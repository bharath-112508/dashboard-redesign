import { TextBlock } from '@/components/TextBlock';
import { questionsOf } from '@/data/selectors';
import { useAppState } from '@/data/store';

/** Project page → Questions tab body (staff and client). Embed placeholder: W4 fills it, W2 mounts it. */
export function ProjectQuestionsTab({ projectId }: { projectId: string }) {
  const n = useAppState((s) => questionsOf(s, projectId).length);
  return <TextBlock tone="info" text={`${n} questions — Questions tab, built by W4.`} testID="project-questions" />;
}
