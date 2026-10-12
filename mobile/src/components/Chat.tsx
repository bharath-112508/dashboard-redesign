import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '@/theme';

import { Avatar } from './Avatar';
import { Chip } from './Chips';
import { TextField } from './fields/TextField';
import { Icon } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

export interface ChatBubbleProps {
  who: string;
  text: string;
  when: string;
  att?: string[];
  /** mine: right-aligned blue (on a question thread: the client side) */
  mine?: boolean;
  /** from a client person: amber bubble (unless mine), initials avatar */
  fromClient?: boolean;
  /** initials avatar without the amber bubble (question threads) */
  initialsOnly?: boolean;
  /** show an image icon on attachment chips (ticket comments), default true */
  attIcon?: boolean;
  testID?: string;
}

/**
 * Chat message (ticket comments, question thread), prototype layout: 30px avatar at the
 * top, then a column (max 78%) with the "**name** · time" caption, the bubble and the
 * attachment chips. Mine is right-aligned and blue.
 */
export function ChatBubble({ who, text, when, att, mine, fromClient, initialsOnly, attIcon = true, testID }: ChatBubbleProps) {
  const bg = mine ? colors.primary : fromClient ? colors.amberSoft : colors.track;
  const fg = mine ? colors.white : colors.ink;
  return (
    <View style={[styles.msg, mine && styles.msgMine]} accessible accessibilityLabel={`${who}, ${when}: ${text}`} testID={testID}>
      <Avatar name={who} size={30} radius={8} initialsOnly={fromClient || initialsOnly} />
      <View style={[styles.col, mine && styles.colMine]}>
        <Txt v="small" w={400} color={colors.ink3}>
          <Txt v="small" w={700}>
            {who}
          </Txt>
          {` · ${when}`}
        </Txt>
        <View style={[styles.bubble, { backgroundColor: bg }]}>
          <Txt v="body" color={fg}>
            {text}
          </Txt>
        </View>
        {att?.length ? (
          <View style={styles.atts}>
            {att.map((a) => (
              <View key={a} style={styles.att}>
                {attIcon ? <Icon name="image" size={12} color={colors.ink} strokeWidth={2.4} /> : null}
                <Txt v="small">{a}</Txt>
              </View>
            ))}
          </View>
        ) : null}
      </View>
    </View>
  );
}

export interface ComposerProps {
  /** "Write a comment…", "Write your answer…", "Reply…" */
  placeholder: string;
  /** called with the text and pending attachments; return true when sent */
  onSend: (text: string, att: string[]) => boolean | void;
  /** attachment name maker: (n) => `photo-${n}.jpg` */
  attachName?: (n: number) => string;
}

/**
 * Fixed composer (ticket and question): pending attachment chips, attach (42px), input
 * (radius 21), send (42px circle, 45% when there is nothing to send). Enter sends.
 * The draft is local: it clears when the screen is left (prototype push/back).
 */
export function Composer({ placeholder, onSend, attachName = (n) => `photo-${n}.jpg` }: ComposerProps) {
  const [text, setText] = useState('');
  const [pend, setPend] = useState<string[]>([]);
  const insets = useSafeAreaInsets();
  const can = !!text.trim() || pend.length > 0;
  const send = () => {
    if (!can) return;
    const r = onSend(text, pend);
    if (r !== false) {
      setText('');
      setPend([]);
    }
  };
  return (
    <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 12) }]} testID="composer">
      {pend.length ? (
        <View style={styles.pend}>
          {pend.map((p) => (
            <Chip key={p} label={p} icon="image" bg={colors.track} fg={colors.ink} />
          ))}
        </View>
      ) : null}
      <View style={styles.bar}>
        <Press
          label="Attach a photo"
          onPress={() => setPend((p) => [...p, attachName(p.length + 1)])}
          style={styles.attach}
          scale={0.94}
          testID="composer-attach"
        >
          <Icon name="paperclip" size={20} color={colors.ink2} />
        </Press>
        <TextField
          label={placeholder.replace('…', '')}
          placeholder={placeholder}
          value={text}
          onChangeText={setText}
          onSubmitEditing={send}
          returnKeyType="send"
          blurOnSubmit={false}
          style={styles.input}
          testID="composer-input"
        />
        <Press
          label="Send"
          onPress={send}
          disabled={!can}
          style={[styles.send, { opacity: can ? 1 : 0.45 }]}
          scale={0.94}
          testID="composer-send"
        >
          <Icon name="send" size={18} color={colors.white} />
        </Press>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  msg: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, maxWidth: '100%' },
  msgMine: { flexDirection: 'row-reverse' },
  col: { maxWidth: '78%', minWidth: 0, alignItems: 'flex-start' },
  colMine: { alignItems: 'flex-end' },
  bubble: { marginTop: 4, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 12 },
  atts: { marginTop: 5, flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  att: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 26,
    paddingHorizontal: 9,
    borderRadius: 7,
    backgroundColor: colors.track,
  },
  composer: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.lineHeader,
    paddingTop: 10,
    paddingHorizontal: 12,
    gap: 8,
  },
  pend: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  attach: {
    width: 42,
    height: 42,
    borderRadius: 12,
    backgroundColor: colors.track,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: { flex: 1, minHeight: 42, borderRadius: 21, paddingVertical: 8 },
  send: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
