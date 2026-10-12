import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { Avatar, AvatarStack } from '@/components/Avatar';
import { Card } from '@/components/Card';
import { ChatBubble, Composer } from '@/components/Chat';
import { Chip, CriticalBadge, Dot, KeyChip } from '@/components/Chips';
import { FactTile, ProgressBar } from '@/components/DataDisplay';
import { EmptyState } from '@/components/EmptyState';
import { TextArea } from '@/components/fields';
import { Icon } from '@/components/Icon';
import { Press } from '@/components/Press';
import { Screen } from '@/components/Screen';
import { showToast } from '@/components/Toast';
import { Txt } from '@/components/Txt';
import { TICKET_STATUS, TICKET_STATUS_ORDER, TICKET_TYPE } from '@/data/constants';
import { dow, hm, sh } from '@/data/format';
import { CLIENT_COMPANY } from '@/data/seed/projects';
import { companyOf, dueInfo, me, personByName, ticketById } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { Ticket } from '@/data/types';
import { openSheet } from '@/nav/routes';
import { colors, radii } from '@/theme';

import { myTicketLog } from './selectors';

/** S-TICKET: ticket detail, staff and client modes, with the comment composer. */
export function TicketDetailScreen({ id }: { id: number }) {
  const ticket = useAppState((s) => ticketById(s, id));
  const person = useAppState(me);
  const visible = useAppState((s) => {
    const t = ticketById(s, id);
    if (!t) return false;
    // DECISIONS.md 9: clients only reach tickets of their own company's projects.
    return me(s)?.role !== 'client' || companyOf(s, t.proj) === CLIENT_COMPANY;
  });
  const { addTicketComment } = useActions();

  if (!ticket || !visible || !person) {
    return (
      <Screen title="Ticket" noTabBar testID="screen-ticket">
        <EmptyState icon="inbox" text="This ticket is not available." />
      </Screen>
    );
  }

  return (
    <Screen
      title={ticket.key}
      noTabBar
      contentStyle={styles.content}
      testID="screen-ticket"
      footer={<Composer placeholder="Write a comment…" onSend={(text, att) => addTicketComment(ticket.id, text, att)} />}
    >
      <TicketBody ticket={ticket} />
    </Screen>
  );
}

function TicketBody({ ticket: t }: { ticket: Ticket }) {
  const person = useAppState(me)!;
  const isClient = person.role === 'client';
  const staff = !isClient;
  const log = useAppState((s) => myTicketLog(s, t.id));
  const commentClients = useAppState((s) => Object.fromEntries(t.comments.map((c) => [c.who, !!personByName(s, c.who)?.client])));
  const { setTicketStatus } = useActions();
  const ty = TICKET_TYPE[t.type];
  const di = dueInfo(t);
  const st = TICKET_STATUS[t.st];
  const over = t.est > 0 && t.hrs > t.est;
  const clientBug = !!t.client;

  return (
    <>
      <View>
        <View style={styles.chips}>
          <KeyChip k={t.key} />
          <Chip label={t.type} icon={ty.icon} bg={ty.soft} fg={ty.ink} />
          {staff && t.prio === 'Critical' ? <CriticalBadge /> : null}
          {staff && clientBug ? <Chip label={`Reported by ${t.reporter ?? 'client'}`} bg={colors.orangeSoft} fg={colors.orangeInk} /> : null}
        </View>
        <Txt v="titleTicket" style={styles.title} accessibilityRole="header">
          {t.title}
        </Txt>
        <Txt v="meta" w={400} color={colors.ink3} style={styles.where}>
          {`${t.proj} · ${t.epic} · ${t.sprint}`}
        </Txt>
      </View>

      {staff ? (
        <View style={styles.statusGrid} accessibilityRole="radiogroup" accessibilityLabel="Status">
          {TICKET_STATUS_ORDER.map((k) => {
            const c = TICKET_STATUS[k];
            const on = t.st === k;
            return (
              <Press
                key={k}
                label={`Status ${c.label}`}
                a11yRole="radio"
                checked={on}
                onPress={() => {
                  const msg = setTicketStatus(t.id, k);
                  if (msg) showToast(msg);
                }}
                scale={0.97}
                style={[styles.statusBtn, on ? { borderColor: c.dot, backgroundColor: c.soft } : null]}
                testID={`ticket-status-${k}`}
              >
                <Dot color={c.dot} size={7} />
                <Txt v="caption" w={700} color={on ? c.ink : colors.ink2} numberOfLines={1}>
                  {c.short}
                </Txt>
              </Press>
            );
          })}
        </View>
      ) : (
        <View style={[styles.banner, { backgroundColor: st.soft }]} testID="ticket-status-banner">
          <Dot color={st.dot} size={10} />
          <Txt v="rowTitle" w={800} color={st.ink}>
            {st.client}
          </Txt>
          <Txt v="caption" w={600} color={st.ink} style={styles.pushRight}>
            Updated by Viljetech
          </Txt>
        </View>
      )}

      <View style={styles.facts}>
        <FactTile
          label="Due"
          locked
          value={t.due ? sh(t.due) : 'No date'}
          valueColor={di.color}
          sub={di.late ? di.label : t.st === 'done' ? 'Done' : di.label}
          subColor={di.late ? colors.danger : colors.ink3}
        />
        {staff ? (
          <FactTile
            label="Hours"
            value={hm(t.hrs)}
            valueColor={over ? colors.danger : colors.ink}
            sub={over ? `${hm(t.hrs - t.est)} over` : `${hm(Math.max(0, t.est - t.hrs))} left`}
            subColor={over ? colors.danger : colors.ink3}
            onPlus={() => openSheet('log-time', { ticketId: t.id })}
            plusLabel="Log time"
          />
        ) : (
          <FactTile label="Reported" value={t.raised ? sh(t.raised) : '—'} sub={`by ${t.reporter ?? 'your team'}`} />
        )}
        {staff ? <FactTile label="Estimate" locked value={hm(t.est)} sub="Locked once set" /> : null}
        <FactTile label={staff ? 'Assignees' : 'Assigned'} sub={t.as.length ? t.as.join(', ') : 'Nobody yet'}>
          <View style={styles.avatars}>
            {t.as.length ? <AvatarStack names={t.as} size={28} overlap={6} /> : <View style={styles.noAvatar} />}
          </View>
        </FactTile>
        {staff ? null : <View style={styles.factSpacer} />}
      </View>

      <Description ticket={t} canEdit={isClient && clientBug} />

      {staff && t.subs ? (
        <Card style={styles.subs} testID="ticket-subtasks">
          <Icon name="corner-down-right" size={18} color={colors.primaryInk} strokeWidth={2.4} />
          <View style={styles.flex}>
            <Txt v="rowTitle" w={800}>{`${t.subs[0]} of ${t.subs[1]} subtasks done`}</Txt>
            <ProgressBar
              pct={t.subs[1] ? (t.subs[0] / t.subs[1]) * 100 : 0}
              height={5}
              track={colors.primarySoft}
              style={styles.subsBar}
              label="Subtasks done"
            />
          </View>
        </Card>
      ) : null}

      {staff && log.length ? (
        <Card testID="ticket-time-log">
          <Txt v="rowTitle" w={800}>
            Time logged
          </Txt>
          {log.map((e) => (
            <View key={String(e.id)} style={styles.logRow}>
              <Avatar name={e.who} size={26} radius={7} />
              <View style={styles.flex}>
                <Txt v="bodySm" numberOfLines={1}>
                  {e.note || e.text || 'Work logged'}
                </Txt>
                <Txt v="small" w={400} color={colors.ink3}>
                  {`${dow(e.d)} ${sh(e.d)}`}
                </Txt>
              </View>
              <Txt v="body" w={800}>
                {hm(e.h)}
              </Txt>
            </View>
          ))}
        </Card>
      ) : null}

      <Card testID="ticket-chat">
        <Txt v="rowTitle" w={800}>
          {clientBug ? (isClient ? 'Chat with Viljetech' : 'Client chat') : 'Comments'}
        </Txt>
        <View style={styles.chat}>
          {t.comments.map((c, i) => (
            <ChatBubble
              key={`${i}-${c.who}`}
              who={c.who}
              text={c.t}
              when={c.when}
              att={c.att}
              mine={c.who === person.name}
              fromClient={commentClients[c.who]}
            />
          ))}
          {!t.comments.length ? (
            <Txt v="body" color={colors.ink3}>
              No comments yet.
            </Txt>
          ) : null}
        </View>
      </Card>
    </>
  );
}

/** Description card; the client edits the description of their own bug (M-20). */
function Description({ ticket: t, canEdit }: { ticket: Ticket; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(t.desc);
  const { setTicketDesc } = useActions();
  const toggle = () => {
    if (editing) {
      setTicketDesc(t.id, draft);
      setEditing(false);
      showToast('Description saved');
    } else {
      setDraft(t.desc);
      setEditing(true);
    }
  };
  return (
    <Card testID="ticket-description">
      <View style={styles.descHead}>
        <Txt v="rowTitle" w={800}>
          Description
        </Txt>
        {canEdit ? (
          <Press label={editing ? 'Save description' : 'Edit description'} onPress={toggle} style={styles.editBtn} scale={0.97} testID="ticket-desc-edit">
            <Txt v="meta" w={700} color={colors.primaryInk}>
              {editing ? 'Save' : 'Edit'}
            </Txt>
          </Press>
        ) : null}
      </View>
      {editing ? (
        <TextArea label="Description" value={draft} onChangeText={setDraft} highlight minHeight={120} style={styles.descInput} testID="ticket-desc-input" />
      ) : (
        <Txt v="bodyLg" color={colors.ink2} style={styles.desc} testID="ticket-desc-text">
          {t.desc}
        </Txt>
      )}
      {t.att.length ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.atts} style={styles.attScroll}>
          {t.att.map((f) => (
            <View key={f} style={styles.att} accessible accessibilityLabel={`Attachment ${f}`}>
              <View style={styles.attImg}>
                <Icon name="image" size={20} color={colors.ink3} />
              </View>
              <Txt v="small" w={600} numberOfLines={1} style={styles.attName}>
                {f}
              </Txt>
            </View>
          ))}
        </ScrollView>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 12 },
  flex: { flex: 1, minWidth: 0 },
  pushRight: { marginLeft: 'auto' },
  chips: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 7 },
  title: { marginTop: 10 },
  where: { marginTop: 4 },
  statusGrid: { flexDirection: 'row', gap: 6 },
  statusBtn: {
    flex: 1,
    height: 38,
    borderRadius: radii.segmentInner,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: radii.input },
  facts: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  factSpacer: { flexBasis: '47%', flexGrow: 1 },
  avatars: { marginTop: 3, flexDirection: 'row' },
  noAvatar: { height: 28 },
  subs: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  subsBar: { marginTop: 6 },
  logRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 9,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  chat: { marginTop: 10, gap: 12 },
  descHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 30 },
  editBtn: { height: 30, paddingHorizontal: 10, borderRadius: radii.chip, backgroundColor: colors.primarySoft, justifyContent: 'center' },
  descInput: { marginTop: 10 },
  desc: { marginTop: 8 },
  attScroll: { marginTop: 12 },
  atts: { gap: 8 },
  att: { width: 110, borderRadius: radii.segmentInner, overflow: 'hidden', borderWidth: 1, borderColor: colors.line },
  attImg: { height: 64, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.track },
  attName: { paddingHorizontal: 7, paddingVertical: 5, fontSize: 11 },
});
