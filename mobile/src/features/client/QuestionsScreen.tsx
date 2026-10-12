import { StyleSheet, View } from 'react-native';

import { Avatar, Card, EmptyState, Screen, StatusPill, Txt } from '@/components';
import { me, questionStatus } from '@/data/selectors';
import { useAppState } from '@/data/store';
import type { Question } from '@/data/types';
import { href, push } from '@/nav/routes';
import { tabTitle } from '@/nav/titles';
import { colors, space } from '@/theme';

/** S-QUESTIONS: the client's questions from the Viljetech team (client tab). */
export function QuestionsScreen() {
  const role = useAppState((s) => me(s)?.role ?? 'client');
  const questions = useAppState((s) => s.questions);
  return (
    <Screen title={tabTitle('questions', role)} header="large" gap={space.gap.cards} testID="screen-questions">
      {questions.length ? (
        questions.map((q) => <QuestionCard key={q.id} q={q} />)
      ) : (
        <EmptyState icon="message-circle-question" text="No questions yet." />
      )}
    </Screen>
  );
}

function QuestionCard({ q }: { q: Question }) {
  const st = questionStatus(q);
  return (
    <Card
      ring={st.needsClient ? colors.dangerRing : colors.line}
      onPress={() => push(href.question(q.id))}
      label={`${q.title}, ${st.label}`}
      style={styles.card}
      testID={`question-card-${q.id}`}
    >
      <View style={styles.top}>
        <StatusPill label={st.label} tone={st} />
        <Txt v="small" w={400} color={colors.ink3}>
          {q.when}
        </Txt>
      </View>
      <Txt v="titleSm">{q.title}</Txt>
      <Txt v="bodySm" w={400} color={colors.ink2} numberOfLines={2} style={styles.text}>
        {q.text}
      </Txt>
      <View style={styles.by}>
        <Avatar name={q.by} size={22} radius={6} initialsOnly />
        <Txt v="caption" color={colors.ink3}>{`Asked by ${q.by} · ${q.tk}`}</Txt>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 7 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  text: { lineHeight: 20 },
  by: { flexDirection: 'row', alignItems: 'center', gap: 7 },
});
