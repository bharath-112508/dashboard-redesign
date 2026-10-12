import { ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, Card, Composer, EmptyState, Icon, KeyChip, Screen, StatusPill, Txt } from '@/components';
import { SCREEN_TITLES } from '@/nav/titles';
import { me, questionById, questionStatus } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { QMsg } from '@/data/types';
import { colors, radii } from '@/theme';

/** S-QUESTION: question card, solved banner, message thread and composer (M-23). */
export function QuestionScreen({ id }: { id: number }) {
  const q = useAppState((s) => questionById(s, id));
  const isClient = useAppState((s) => me(s)?.role === 'client');
  const { addQuestionMessage } = useActions();

  if (!q) {
    return (
      <Screen title={SCREEN_TITLES.question} noTabBar testID="screen-question">
        <EmptyState icon="message-circle-question" text="This question no longer exists." />
      </Screen>
    );
  }
  const st = questionStatus(q);
  return (
    <Screen
      title={SCREEN_TITLES.question}
      noTabBar
      testID="screen-question"
      contentStyle={styles.content}
      footer={
        <Composer
          placeholder={isClient ? 'Write your answer…' : 'Reply…'}
          onSend={(text, att) => addQuestionMessage(q.id, text, att)}
        />
      }
    >
      <Card pad={16} radius={radii.hero} testID="question-head">
        <View style={styles.chips}>
          <StatusPill label={st.label} tone={st} />
          <KeyChip k={q.tk} />
        </View>
        <Txt v="titleMd" style={styles.title} accessibilityRole="header">
          {q.title}
        </Txt>
        <Txt v="bodyLg" color={colors.ink2} style={styles.text}>
          {q.text}
        </Txt>
        {q.att.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.atts} style={styles.attRow}>
            {q.att.map((f) => (
              <AttachmentTile key={f} name={f} />
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.by}>
          <Avatar name={q.by} size={22} radius={6} initialsOnly />
          <Txt v="caption" color={colors.ink3}>{`Asked by ${q.by} · ${q.when}`}</Txt>
        </View>
      </Card>
      {q.solved ? (
        <View style={styles.solved} testID="question-solved">
          <Icon name="check" size={16} color={colors.greenInk} strokeWidth={2.8} />
          <Txt v="body" w={700} color={colors.greenInk}>
            Marked solved by the developer
          </Txt>
        </View>
      ) : null}
      <View style={styles.thread} testID="question-thread">
        {q.msgs.map((m, i) => (
          <QuestionMessage key={i} m={m} />
        ))}
      </View>
    </Screen>
  );
}

/** 120px attachment tile: image placeholder and the file name. */
function AttachmentTile({ name }: { name: string }) {
  return (
    <View style={styles.tile} accessible accessibilityLabel={`Attachment ${name}`}>
      <View style={styles.tileImg}>
        <Icon name="image" size={20} color={colors.ink3} />
      </View>
      <Txt v="small" style={styles.tileName} numberOfLines={1}>
        {name}
      </Txt>
    </View>
  );
}

/**
 * One message: the client's side is right-aligned and blue, Viljetech's is left-aligned
 * on the soft track colour. Name and time sit above the bubble (prototype layout).
 */
function QuestionMessage({ m }: { m: QMsg }) {
  const client = m.side === 'client';
  return (
    <View
      style={[styles.msg, client && styles.msgClient]}
      accessible
      accessibilityLabel={`${m.who}, ${m.when}: ${m.t}`}
      testID={`question-msg-${m.side}`}
    >
      <Avatar name={m.who} size={30} radius={8} initialsOnly />
      <View style={[styles.msgCol, client && styles.msgColClient]}>
        <Txt v="small" w={400} color={colors.ink3}>
          <Txt v="small" w={700}>
            {m.who}
          </Txt>
          {` · ${m.when}`}
        </Txt>
        <View style={[styles.bubble, { backgroundColor: client ? colors.primary : colors.track }]}>
          <Txt v="body" color={client ? colors.white : colors.ink}>
            {m.t}
          </Txt>
        </View>
        {m.att?.length ? (
          <View style={styles.msgAtts}>
            {m.att.map((f) => (
              <View key={f} style={styles.msgAtt}>
                <Txt v="small">{f}</Txt>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 12 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  title: { marginTop: 10, lineHeight: 26 },
  text: { marginTop: 8 },
  attRow: { marginTop: 12 },
  atts: { gap: 8 },
  tile: { width: 120, borderRadius: 10, overflow: 'hidden', borderWidth: 1, borderColor: colors.line },
  tileImg: { height: 70, backgroundColor: colors.track, alignItems: 'center', justifyContent: 'center' },
  tileName: { paddingVertical: 5, paddingHorizontal: 7, fontSize: 11 },
  by: { marginTop: 12, flexDirection: 'row', alignItems: 'center', gap: 7 },
  solved: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: radii.input,
    backgroundColor: colors.greenSoft,
  },
  thread: { gap: 12 },
  msg: { flexDirection: 'row', gap: 9 },
  msgClient: { flexDirection: 'row-reverse' },
  msgCol: { maxWidth: '78%', minWidth: 0, alignItems: 'flex-start' },
  msgColClient: { alignItems: 'flex-end' },
  bubble: { marginTop: 4, paddingVertical: 10, paddingHorizontal: 12, borderRadius: 14 },
  msgAtts: { marginTop: 5, flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  msgAtt: { height: 26, paddingHorizontal: 9, borderRadius: 7, backgroundColor: colors.track, justifyContent: 'center' },
});
