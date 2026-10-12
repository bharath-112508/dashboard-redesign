import { Block, Button, Rows } from '@/components';
import { useAppState } from '@/data/store';
import { openSheet } from '@/nav/routes';

import { BugRow } from './rows';

/** Project page → Bugs tab body (clients): bugs on this project (A-16). W2 mounts it. */
export function ProjectBugsTab({ projectId }: { projectId: string }) {
  const B = useAppState((s) => s.bugs.filter((b) => b.projectId === projectId));
  return (
    <>
      <Button title="Report a bug" icon="bug" onPress={() => openSheet('report-bug', { pid: projectId })} testID="project-report-bug" />
      <Block title="Bugs reported">
        <Rows empty="No bugs reported." testID="project-bugs">
          {B.map((b) => (
            <BugRow key={b.id} b={b} />
          ))}
        </Rows>
      </Block>
    </>
  );
}
