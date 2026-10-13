import { useEffect, useState } from 'react';

import {
  Avatar,
  Block,
  Button,
  CommentThread,
  EmptyBlock,
  FieldList,
  FileField,
  Form,
  Hero,
  IconTile,
  ProgressList,
  Row,
  Rows,
  Screen,
  TextBlock,
  TextField,
  TicketRow,
  openTicket,
  toastResult,
} from '@/components';
import { PRIORITY_DOT, TICKET_STATUS } from '@/data/constants';
import { fmt, fmtL, hm } from '@/data/format';
import { dueInfo, entriesAll, epicName, isClient, loggedMin, myPerm, project, projValue, sprint, ticket } from '@/data/selectors';
import { actions as storeActions, useActions, useAppState } from '@/data/store';
import { openLog } from '@/features/time/openLog';
import { href, push } from '@/nav/routes';
import { colors, tones } from '@/theme';

import { SubtaskRow } from './SubtaskRow';
import { DescSheet, LinkSheet, TicketFieldSheet, type TicketField } from './TicketSheets';

const IMG = /\.(png|jpe?g|svg|gif|webp)$/i;

/** S5-TICKET Ticket detail (V-20…V-29). Staff edit everything; clients only read it. */
export function TicketScreen({ ticketKey }: { ticketKey: string }) {
  const t = useAppState((s) => ticket(s, ticketKey));
  const client = useAppState(isClient);
  const canAssign = useAppState((s) => myPerm(s, 'tickets.assign'));
  const p = useAppState((s) => (t ? project(s, t.projectId) : null));
  const epic = useAppState((s) => (t ? epicName(s, t.epicId) : ''));
  const sp = useAppState((s) => (t ? sprint(s, t.sprintId) : null));
  const lg = useAppState((s) => (t ? loggedMin(s, t.key) : 0));
  const entries = useAppState((s) =>
    t
      ? entriesAll(s)
          .filter((e) => e.key === t.key)
          .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      : [],
  );
  const blockers = useAppState((s) => (t ? t.blk.map((k) => ticket(s, k)) : []));
  const { addSubtask, addTicketComment, attachToTicket } = useActions();
  const [field, setField] = useState<TicketField | null>(null);
  const [sheet, setSheet] = useState<'desc' | 'link' | null>(null);
  const [subText, setSubText] = useState('');

  // V-20: opening a ticket (also by deep link) clears its unread count for staff.
  useEffect(() => {
    if (t?.unread) storeActions.markTicketRead(t.key);
  }, [t?.key, t?.unread]);

  if (!t) {
    return (
      <Screen title="Ticket" testID="screen-ticket">
        <EmptyBlock text="Ticket not found." />
      </Screen>
    );
  }
  const ed = !client;
  const st = TICKET_STATUS[t.st];
  const due = dueInfo(t);
  const F = (k: TicketField) => (ed ? () => setField(k) : undefined);
  const n = t.subs.length;
  const dn = t.subs.filter((x) => x.st === 'done').length;
  const over = !!t.est && lg / 60 > t.est;

  return (
    <Screen title={t.key} sub={p?.name} testID="screen-ticket">
      <Hero
        eyebrow={`${t.key} · ${t.type}${t.client ? ' · From client' : ''}`}
        title={t.title}
        sub={`${p?.name ?? ''} · ${epic}`}
        status={{ label: client ? st.client : st.label, tone: st.tone }}
        onStatus={F('st')}
        chips={[
          { text: t.prio, dot: PRIORITY_DOT[t.prio], bg: colors.bg, color: colors.ink2 },
          {
            text: t.due ? `Due ${fmt(t.due)}` : 'No due date',
            dot: due.late ? colors.danger : colors.faint,
            bg: due.late ? colors.redSoft : colors.bg,
            color: due.late ? colors.redInk : colors.ink2,
          },
        ]}
        testID="ticket-hero"
      />
      {client ? <TextBlock tone="info" text="The team updates this ticket. To reach them, report a bug or answer their questions." testID="ticket-client-info" /> : null}
      <Block title="Ticket details">
        <FieldList
          testID="ticket-fields"
          items={[
            { label: 'Status', value: client ? st.client : st.label, dot: tones[st.tone].dot, onPress: F('st'), testID: 'tf-st' },
            { label: 'Priority', value: t.prio, dot: PRIORITY_DOT[t.prio], onPress: F('prio'), testID: 'tf-prio' },
            { label: 'Assignees', value: t.as.length ? t.as.join(', ') : 'Unassigned', onPress: ed && canAssign ? F('as') : undefined, testID: 'tf-as' },
            !client && { label: 'Sprint', value: sp ? sp.name : 'Backlog', onPress: F('sprint'), testID: 'tf-sprint' },
            { label: 'Start', value: t.start ? fmtL(t.start) : '', onPress: F('start'), testID: 'tf-start' },
            { label: 'Due date', value: t.due ? fmtL(t.due) : '', color: due.late ? colors.danger : colors.ink, onPress: F('due'), testID: 'tf-due' },
            !client && { label: 'Estimate', value: t.est ? `${t.est}h` : '', onPress: F('est'), testID: 'tf-est' },
            !client && { label: 'Logged', value: `${hm(lg)}${t.est ? ` of ${t.est}h` : ''}`, color: over ? colors.danger : colors.ink, testID: 'tf-logged' },
          ]}
        />
      </Block>
      <Block title="Description" action={ed ? 'Edit' : undefined} onAction={ed ? () => setSheet('desc') : undefined} actionTestID="desc-edit">
        <TextBlock text={t.desc || 'No description yet.'} testID="ticket-desc" />
      </Block>
      <Block title="Subtasks" sub={n ? `${dn} of ${n} done` : 'No subtasks yet'} testID="ticket-subtasks">
        <Rows empty="No subtasks yet.">
          {t.subs.map((x) => (
            <SubtaskRow key={x.id} id={x.id} editable={ed} client={client} onPress={() => push(href.subtask(x.id))} />
          ))}
        </Rows>
      </Block>
      {n ? (
        <ProgressList
          items={[{ title: 'Progress', used: dn, of: n, value: `${Math.round((dn / n) * 100)}%`, caption: `${dn} of ${n} subtasks done`, color: colors.green }]}
          testID="sub-progress"
        />
      ) : null}
      {ed ? (
        <>
          <Form>
            <TextField label="" placeholder="Add a subtask" value={subText} onChange={setSubText} testID="sub-add-input" />
          </Form>
          <Button
            title="Add subtask"
            icon="plus"
            kind={subText.trim() ? 'p' : 's'}
            onPress={() => {
              if (!subText.trim()) return;
              const r = addSubtask(t.key, subText);
              if (r.ok) setSubText('');
              toastResult(r);
            }}
            testID="sub-add"
          />
        </>
      ) : null}
      {ed ? (
        <Block title="Blocked by" action="+ Link task" onAction={() => setSheet('link')} actionTestID="link-open" testID="ticket-blocked">
          <Rows empty="Nothing">
            {blockers.map((b, i) =>
              b ? <TicketRow key={b.key} ticket={b} onPress={() => openTicket(b.key)} testID={`blk-${b.key}`} /> : <Row key={i} title={t.blk[i]} />,
            )}
          </Rows>
        </Block>
      ) : null}
      <Block title="Attachments" testID="ticket-attachments">
        <Rows empty="No attachments.">
          {t.att.map((f, i) => (
            <Row
              key={`${f.n}-${i}`}
              lead={<IconTile icon={IMG.test(f.n) ? 'image' : 'paperclip'} />}
              title={f.n}
              sub={`${f.size} · ${fmt(f.when)}`}
              testID={`att-${i}`}
            />
          ))}
        </Rows>
      </Block>
      {ed ? (
        <Form>
          <FileField
            label=""
            title="Attach a file"
            sub="Click to browse · any file type"
            accept="*/*"
            value={null}
            onPick={(f) => toastResult(attachToTicket(t.key, { n: f.n, size: f.size }))}
            testID="attach"
          />
        </Form>
      ) : null}
      {ed ? (
        <Block
          title="Time"
          sub={`${hm(lg)} logged`}
          action="Log"
          onAction={() => p && openLog({ proj: projValue(p), key: t.key })}
          actionTestID="ticket-log"
          testID="ticket-time"
        >
          <Rows empty="No time logged yet.">
            {entries.slice(0, 6).map((e) => (
              <Row
                key={e.id}
                lead={<Avatar name={e.who} />}
                title={e.who}
                sub={`${fmtL(e.date)}${e.note ? ` · ${e.note}` : ''}`}
                right={hm(e.min)}
                rightColor={colors.ink}
                rightWeight={700}
              />
            ))}
          </Rows>
        </Block>
      ) : null}
      <Block title="Comments" sub={`${t.comments.length} comments`}>
        <CommentThread
          comments={t.comments}
          onSend={
            client
              ? undefined
              : (text) => {
                  const r = addTicketComment(t.key, text);
                  if (!r.ok) toastResult(r);
                  return r.ok;
                }
          }
          testID="ticket-comments"
        />
      </Block>
      <TicketFieldSheet ticket={t} f={field} onClose={() => setField(null)} />
      <DescSheet ticket={t} open={sheet === 'desc'} onClose={() => setSheet(null)} />
      <LinkSheet ticket={t} open={sheet === 'link'} onClose={() => setSheet(null)} />
    </Screen>
  );
}
