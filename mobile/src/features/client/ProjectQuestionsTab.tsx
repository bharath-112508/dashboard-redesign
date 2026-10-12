import { Block, Button, Rows } from '@/components';
import { isClient, questionsOf } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { openSheet } from '@/nav/routes';

import { QuestionRow } from './rows';

/** Project page → Questions tab body (staff and client). W2 mounts it. */
export function ProjectQuestionsTab({ projectId }: { projectId: string }) {
  const Q = useAppState((s) => questionsOf(s, projectId));
  const cl = useAppState(isClient);
  return (
    <>
      {cl ? null : (
        <Button title="Raise question to client" icon="message-circle-question" onPress={() => openSheet('new-question', { pid: projectId })} testID="project-raise-question" />
      )}
      <Block title="Questions to client" sub={cl ? 'Answer so the team can continue' : 'Clients see these in their portal'}>
        <Rows empty="No questions raised yet." testID="project-questions">
          {Q.map((q) => (
            <QuestionRow key={q.id} q={q} />
          ))}
        </Rows>
      </Block>
    </>
  );
}
