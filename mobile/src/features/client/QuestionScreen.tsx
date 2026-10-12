import { useState } from 'react';

import { Avatar, Block, Button, EmptyBlock, Hero, Screen, TextArea, TextBlock, showToast } from '@/components';
import { isClient, project, question } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { openSheet } from '@/nav/routes';
import { colors } from '@/theme';

/**
 * S5-QUESTION: hero, question text, the answer, the client's answer form (V-60) or the
 * staff note / "Ask a follow-up" (V-53).
 */
export function QuestionScreen({ id }: { id: string }) {
  const q = useAppState((s) => question(s, id));
  const cl = useAppState(isClient);
  const p = useAppState((s) => (q ? project(s, q.projectId) : null));
  const { answerQuestion } = useActions();
  const [ans, setAns] = useState('');
  const [err, setErr] = useState('');

  if (!q) {
    return (
      <Screen title="Question" testID="screen-question">
        <EmptyBlock text="Question not found." />
      </Screen>
    );
  }
  const answered = !!q.answer;
  const send = () => {
    const r = answerQuestion(q.id, ans);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    setAns('');
    setErr('');
    showToast(r.toast);
  };
  return (
    <Screen title="Question" sub={p?.name} testID="screen-question">
      <Hero
        lead={<Avatar name={q.by} size={46} radius={13} />}
        eyebrow={`Q-${q.id} · ${p?.name ?? ''}`}
        title={q.title}
        sub={`Asked by ${q.by} · ${q.when}`}
        status={{ label: answered ? 'Answered' : 'Waiting', tone: answered ? 'green' : 'amber' }}
        chips={q.task ? [{ text: `Linked to ${q.task}`, dot: colors.primary, bg: colors.bg, color: colors.ink2 }] : undefined}
        testID="question-hero"
      />
      <Block title="Question">
        <TextBlock text={q.text} />
      </Block>
      {answered ? (
        <Block title="Answer" sub={q.answeredBy ? `By ${q.answeredBy}` : undefined}>
          <TextBlock tone="good" text={q.answer} testID="question-answer" />
        </Block>
      ) : null}
      {cl && !answered ? (
        <>
          <Block title="Your answer">
            <TextArea label="" value={ans} onChange={setAns} placeholder="Type your answer…" error={err} testID="question-answer-input" />
          </Block>
          <Button title="Send answer" icon="send-horizontal" onPress={send} testID="question-send" />
        </>
      ) : null}
      {!cl && !answered ? <TextBlock tone="note" text="Waiting for the client to answer. They see this in their portal." /> : null}
      {!cl && answered ? (
        <Button title="Ask a follow-up" kind="s" icon="reply" onPress={() => openSheet('new-question', { pid: q.projectId, title: `Re: ${q.title}` })} testID="question-follow-up" />
      ) : null}
    </Screen>
  );
}
