import { router } from 'expo-router';
import { useState } from 'react';

import {
  Avatar,
  Block,
  Button,
  ButtonRow,
  CommentThread,
  ConfirmSheet,
  EmptyBlock,
  FieldList,
  Hero,
  Row,
  Rows,
  Screen,
  TextBlock,
  TicketRow,
  showToast,
  toastResult,
} from '@/components';
import { TODAY } from '@/data/clock';
import { PRIORITY_DOT, PRIORITY_SOFT, TICKET_STATUS } from '@/data/constants';
import { diff, fmt, fmtL, hm } from '@/data/format';
import { entriesAll, isClient, loggedMin, project, projValue, subOf } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { openLog } from '@/features/time/openLog';
import { back } from '@/nav/routes';
import { colors, tones } from '@/theme';

import { SubtaskRow } from './SubtaskRow';
import { SubFieldSheet, SubNoteSheet, type SubField } from './TicketSheets';

/** Step to another subtask in place (Previous / Next / All subtasks), by stable id. */
const showSub = (id: string) => router.setParams({ key: id });

/** S5-SUB Subtask (V-24…V-26). `subId` is the stable id ("PMT-11.s2", A-11). */
export function SubtaskScreen({ subId }: { subId: string }) {
  const x = useAppState((s) => subOf(s, subId));
  const client = useAppState(isClient);
  const lg = useAppState((s) => loggedMin(s, subId));
  const p = useAppState((s) => (x ? project(s, x.parent.projectId) : null));
  const entries = useAppState((s) =>
    x
      ? entriesAll(s)
          .filter((e) => e.key === x.id || e.key === x.key)
          .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      : [],
  );
  const { toggleSubtask, commentOnSubtask, deleteSubtask } = useActions();
  const [field, setField] = useState<SubField | null>(null);
  const [note, setNote] = useState(false);
  const [confirm, setConfirm] = useState(false);

  if (!x) {
    return (
      <Screen title="Subtask" testID="screen-subtask">
        <EmptyBlock text="This subtask was deleted." />
      </Screen>
    );
  }
  const t = x.parent;
  const ed = !client;
  const n = t.subs.length;
  const st = TICKET_STATUS[x.st];
  const d = x.due ? diff(x.due, TODAY) : null;
  const late = d != null && d < 0 && !x.done;
  const F = (k: SubField) => (ed ? () => setField(k) : undefined);
  const prev = t.subs[x.index - 1];
  const next = t.subs[x.index + 1];
  const soft = PRIORITY_SOFT[x.prio];
  const time = x.est ? `${hm(lg)} / ${x.est}h` : lg ? `${hm(lg)} logged` : 'No estimate';

  return (
    <Screen title={x.key} sub={t.title} testID="screen-subtask">
      <Hero
        eyebrow={`${x.key} · Subtask ${x.index + 1} of ${n}`}
        title={x.title}
        status={{ label: client ? st.client : st.label, tone: st.tone }}
        onStatus={F('st')}
        chips={[
          { text: x.prio, dot: PRIORITY_DOT[x.prio], bg: soft.bg, color: soft.ink },
          {
            text: x.due ? `${late ? 'Overdue' : 'Due'} ${fmt(x.due)}` : 'No due date',
            dot: late ? colors.danger : colors.faint,
            bg: late ? colors.redSoft : colors.bg,
            color: late ? colors.redInk : colors.ink2,
          },
        ]}
        testID="sub-hero"
      />
      {ed ? (
        <Button
          title={x.done ? 'Done · reopen' : 'Mark done'}
          kind={x.done ? 's' : 'g'}
          icon={x.done ? 'rotate-ccw' : 'check'}
          onPress={() => toastResult(toggleSubtask(t.key, x.id, { short: true }))}
          testID="sub-done"
        />
      ) : null}
      <Block title="Parent">
        <Rows>
          <TicketRow ticket={t} sub={`Parent ticket · ${p?.name ?? ''}`} onPress={back} testID="sub-parent" />
        </Rows>
      </Block>
      <Block title="Details">
        <FieldList
          testID="sub-fields"
          items={[
            { label: 'Status', value: client ? st.client : st.label, dot: tones[st.tone].dot, onPress: F('st'), testID: 'sf-st' },
            { label: 'Priority', value: x.prio, dot: PRIORITY_DOT[x.prio], onPress: F('prio'), testID: 'sf-prio' },
            { label: 'Assignee', value: x.as || 'Unassigned', onPress: F('as'), testID: 'sf-as' },
            { label: 'Due date', value: x.due ? fmtL(x.due) : '', color: late ? colors.danger : colors.ink, onPress: F('due'), testID: 'sf-due' },
            !client && { label: 'Estimate', value: x.est ? `${x.est}h` : '', onPress: F('est'), testID: 'sf-est' },
            !client && { label: 'Time', value: time, color: x.est && lg / 60 > x.est ? colors.destructiveInk : colors.ink, testID: 'sf-time' },
          ]}
        />
      </Block>
      <Block title="Notes" sub="Details for this subtask" action={ed ? 'Edit' : undefined} onAction={ed ? () => setNote(true) : undefined} actionTestID="note-edit">
        <TextBlock text={x.note || 'No notes yet.'} testID="sub-note" />
      </Block>
      {ed ? (
        <Block
          title="Time"
          sub={`${hm(lg)} logged`}
          action="Log"
          onAction={() => p && openLog({ proj: projValue(p), key: x.id })}
          actionTestID="sub-log"
        >
          <Rows empty="No time logged yet.">
            {entries.map((e) => (
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
      <Block title="Comments">
        <CommentThread
          comments={x.comments}
          onSend={
            client
              ? undefined
              : (text) => {
                  const r = commentOnSubtask(t.key, x.id, text);
                  if (!r.ok) toastResult(r);
                  return r.ok;
                }
          }
          testID="sub-comments"
        />
      </Block>
      <ButtonRow>
        <Button title="Previous" kind="s" icon="chevron-left" disabled={!prev} onPress={() => prev && showSub(prev.id)} testID="sub-prev" />
        <Button title="Next" kind="s" icon="chevron-right" disabled={!next} onPress={() => next && showSub(next.id)} testID="sub-next" />
      </ButtonRow>
      <Block title="All subtasks" sub={`${t.key} · ${t.title}`}>
        <Rows>
          {t.subs.map((y) => (
            <SubtaskRow key={y.id} id={y.id} editable={ed} client={client} current={y.id === x.id} onPress={y.id === x.id ? undefined : () => showSub(y.id)} />
          ))}
        </Rows>
      </Block>
      {ed ? <Button title="Delete subtask" kind="d" icon="trash-2" onPress={() => setConfirm(true)} testID="sub-delete" /> : null}
      <SubFieldSheet sub={x} f={field} onClose={() => setField(null)} />
      <SubNoteSheet sub={x} open={note} onClose={() => setNote(false)} />
      <ConfirmSheet
        visible={confirm}
        title={`Delete ${x.key}?`}
        text={`“${x.title}” is removed from ${t.key}. Logged time is kept.`}
        confirm="Delete subtask"
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          const r = deleteSubtask(t.key, x.id);
          if (r.ok) {
            back();
            showToast(r.toast);
          } else toastResult(r);
        }}
        testID="sheet-delete-subtask"
      />
    </Screen>
  );
}
