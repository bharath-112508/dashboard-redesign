import { TextBlock } from '@/components/TextBlock';
import { devopsFor } from '@/data/selectors';
import { useAppState } from '@/data/store';

/**
 * Project page → DevOps tab body (S5-PROJECT DevOps). Embed placeholder: W4 fills it,
 * W2 mounts it. Look the record up by `projectId` only (DECISIONS 3).
 */
export function ProjectDevopsTab({ projectId }: { projectId: string }) {
  const d = useAppState((s) => devopsFor(s, projectId));
  if (!d) return <TextBlock tone="info" text="This project is not on the DevOps board yet." testID="project-devops-none" />;
  return <TextBlock tone="info" text={`${d.key} · ${d.infra} — DevOps tab, built by W4.`} testID="project-devops" />;
}
