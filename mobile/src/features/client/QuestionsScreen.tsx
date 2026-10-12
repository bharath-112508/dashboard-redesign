import { useState } from 'react';

import { Rows, Screen, Segmented } from '@/components';
import { isOpenQuestion, visibleQuestions } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { useRootActions } from '@/nav/useRootActions';

import { filterQuestions, type QuestionFilter } from './client';
import { QuestionRow } from './rows';

/** S5-QUESTIONS (clients tab): Waiting for you (n) · Answered (V-65). */
export function QuestionsScreen() {
  const Q = useAppState(visibleQuestions);
  const actions = useRootActions();
  const [v, setV] = useState<QuestionFilter>('wait');
  const L = filterQuestions(Q, v);
  return (
    <Screen title="Questions" sub="From the Viljetech team" actions={actions} testID="screen-questions">
      <Segmented
        options={[
          { value: 'wait', label: 'Waiting for you', count: Q.filter(isOpenQuestion).length },
          { value: 'done', label: 'Answered' },
        ]}
        value={v}
        onChange={setV}
        testID="questions-seg"
      />
      <Rows empty={v === 'wait' ? 'No questions waiting. Nice.' : 'Nothing answered yet.'} testID="questions">
        {L.map((q) => (
          <QuestionRow key={q.id} q={q} />
        ))}
      </Rows>
    </Screen>
  );
}
