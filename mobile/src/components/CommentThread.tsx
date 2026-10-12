import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import type { Comment } from '@/data/types';
import { myName } from '@/data/selectors/session';
import { useAppState } from '@/data/store';
import { colors, fontFamily, radii } from '@/theme';

import { Avatar } from './Avatar';
import { Icon } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

export interface CommentThreadProps {
  comments: Comment[];
  /** empty text ("No comments yet.") */
  empty?: string;
  /** shows the composer; return true when the comment was posted (the field clears) */
  onSend?: (text: string) => boolean | void;
  placeholder?: string;
  testID?: string;
}

/**
 * Comments (SPEC §6.2): bubbles with a 32px avatar, max 78%, r14, "who · when"; mine on
 * the right in blue; an inline composer (textarea 46h r14 + a 46px send button, blue
 * when there is text).
 */
export function CommentThread({ comments, empty = 'No comments yet.', onSend, placeholder = 'Write a comment…', testID = 'comments' }: CommentThreadProps) {
  const me = useAppState(myName);
  const [text, setText] = useState('');
  const can = !!text.trim();
  const send = () => {
    if (!can || !onSend) return;
    if (onSend(text.trim()) !== false) setText('');
  };
  return (
    <View style={styles.wrap} testID={testID}>
      {comments.map((c, i) => {
        const mine = c.who === me;
        return (
          <View key={i} style={[styles.msg, mine && styles.mine]}>
            <Avatar name={c.who} size={32} />
            <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleOther]}>
              <Txt v="meta" w={700} color={mine ? colors.white : colors.ink}>
                {c.who}
                <Txt v="meta" w={500} color={mine ? colors.white : colors.ink} style={styles.when}>
                  {` · ${c.when}`}
                </Txt>
              </Txt>
              <Txt v="body" color={mine ? colors.white : colors.ink} style={styles.text}>
                {c.t}
              </Txt>
            </View>
          </View>
        );
      })}
      {!comments.length ? (
        <Txt v="label" w={400} color={colors.ink3} style={styles.none}>
          {empty}
        </Txt>
      ) : null}
      {onSend ? (
        <View style={styles.composer}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={placeholder}
            placeholderTextColor={colors.ink3}
            accessibilityLabel={placeholder}
            multiline
            style={styles.input}
            testID={`${testID}-input`}
          />
          <Press label="Send" onPress={send} disabled={!can} style={[styles.send, { backgroundColor: can ? colors.primary : colors.sendOff }]} testID={`${testID}-send`}>
            <Icon name="send-horizontal" size={18} color={colors.white} />
          </Press>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  msg: { flexDirection: 'row', gap: 10 },
  mine: { flexDirection: 'row-reverse' },
  bubble: { maxWidth: '78%', paddingVertical: 10, paddingHorizontal: 12, borderRadius: radii.button },
  bubbleMine: { backgroundColor: colors.primary },
  bubbleOther: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.ringCard },
  when: { opacity: 0.75 },
  text: { marginTop: 2 },
  none: { paddingVertical: 6, paddingHorizontal: 4 },
  composer: { flexDirection: 'row', gap: 8, alignItems: 'flex-end' },
  input: {
    flex: 1,
    minHeight: 46,
    maxHeight: 140,
    borderWidth: 1,
    borderColor: colors.lineInput,
    borderRadius: radii.button,
    paddingVertical: 12,
    paddingHorizontal: 14,
    fontFamily: fontFamily[400],
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.surface,
  },
  send: { width: 46, height: 46, borderRadius: radii.button, alignItems: 'center', justifyContent: 'center' },
});
