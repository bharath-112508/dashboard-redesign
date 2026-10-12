import { StyleSheet, View } from 'react-native';

import { EmptyState } from '@/components/EmptyState';
import { IconTile } from '@/components/IconTile';
import type { IconName } from '@/components/icons';
import { Press } from '@/components/Press';
import { Screen } from '@/components/Screen';
import { Txt } from '@/components/Txt';
import { notifications, unreadCount, type NotificationRow } from '@/data/selectors';
import { actions, store, useActions, useAppState } from '@/data/store';
import { notificationHref, push } from '@/nav/routes';
import { SCREEN_TITLES } from '@/nav/titles';
import { colors, radii } from '@/theme';

/**
 * Open a notification (M-06): mark it read, expand the DevOps card for the deploy
 * notification, then push its target.
 */
export function openNotification(n: NotificationRow): void {
  actions.markRead(n.id);
  if (n.target.kind === 'devops') {
    const open = { ...store.getState().ui.devopsOpen, [n.target.project]: true };
    actions.setUi({ devopsOpen: open });
  }
  push(notificationHref(n.target));
}

/** S-INBOX: the role's notification feed; "Mark all read" while anything is unread. */
export function InboxScreen() {
  const rows = useAppState(notifications);
  const unread = useAppState(unreadCount);
  const { markAllRead } = useActions();

  return (
    <Screen
      title={SCREEN_TITLES.inbox}
      action={unread ? { label: 'Mark all read', onPress: markAllRead, testID: 'inbox-mark-all' } : undefined}
      contentStyle={styles.content}
      testID="screen-inbox"
    >
      {rows.length ? (
        <View style={styles.card}>
          {rows.map((n, i) => (
            <Press
              key={n.id}
              label={`${n.text}, ${n.when}${n.unread ? ', unread' : ''}`}
              onPress={() => openNotification(n)}
              scale={1}
              style={[styles.row, i > 0 && styles.divider, { backgroundColor: n.unread ? colors.unreadBg : colors.surface }]}
              testID={`notification-${n.id}`}
            >
              <IconTile icon={n.icon as IconName} bg={n.tone.bg} fg={n.tone.fg} size={34} radius={10} iconSize={17} />
              <View style={styles.text}>
                <Txt v="body" w={n.unread ? 700 : 500} style={styles.line}>
                  {n.text}
                </Txt>
                <Txt v="small" w={400} color={colors.ink3}>
                  {n.when}
                </Txt>
              </View>
              {n.unread ? <View style={styles.dot} testID={`notification-unread-${n.id}`} /> : null}
            </Press>
          ))}
        </View>
      ) : (
        <EmptyState icon="bell" text="No notifications." />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 12 },
  card: { backgroundColor: colors.surface, borderRadius: radii.card, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 13, paddingHorizontal: 14 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  text: { flex: 1, minWidth: 0, gap: 3 },
  line: { lineHeight: 20 },
  dot: { marginTop: 6, width: 9, height: 9, borderRadius: 5, backgroundColor: colors.primary },
});
