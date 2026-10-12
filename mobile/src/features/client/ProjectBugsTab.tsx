import { TextBlock } from '@/components/TextBlock';
import { useAppState } from '@/data/store';

/** Project page → Bugs tab body (clients). Embed placeholder: W4 fills it, W2 mounts it. */
export function ProjectBugsTab({ projectId }: { projectId: string }) {
  const n = useAppState((s) => s.bugs.filter((b) => b.projectId === projectId).length);
  return <TextBlock tone="info" text={`${n} bugs — Bugs tab, built by W4.`} testID="project-bugs" />;
}
