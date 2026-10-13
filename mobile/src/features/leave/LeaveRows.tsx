import { useState } from 'react';

import { Avatar } from '@/components/Avatar';
import { BottomSheet } from '@/components/BottomSheet';
import { Button, ButtonRow } from '@/components/Buttons';
import { FieldList } from '@/components/FieldList';
import { Row, Rows } from '@/components/Row';
import { TextBlock } from '@/components/TextBlock';
import { toastResult } from '@/components/Toast';
import { myPerm } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { Leave } from '@/data/types';

import { LEAVE_STATUS, leaveDates, leaveKindLabel, leaveSub } from './leave';

/**
 * Leave request rows (avatar, "Who · Kind", dates · days · reason, status badge). A tap
 * opens SH-APPROVE (inline) for that request.
 */
export function LeaveRows({ items, empty, testID }: { items: Leave[]; empty?: string; testID?: string }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <Rows empty={empty} testID={testID}>
        {items.map((l) => (
          <Row
            key={l.id}
            lead={<Avatar name={l.who} />}
            title={`${l.who} · ${leaveKindLabel(l.kind)}`}
            sub={leaveSub(l)}
            subWrap
            badge={{ label: LEAVE_STATUS[l.st].label, tone: LEAVE_STATUS[l.st].tone }}
            onPress={() => setOpen(l.id)}
            testID={`leave-${l.id}`}
          />
        ))}
      </Rows>
      <ApproveSheet id={open} onClose={() => setOpen(null)} />
    </>
  );
}

/**
 * SH-APPROVE (V-74): Dates, Days, Reason, Status. With `leave.approve` and pending:
 * Reject / Approve. Otherwise the info "Admins approve leave."
 */
export function ApproveSheet({ id, onClose }: { id: number | null; onClose: () => void }) {
  const l = useAppState((s) => (id == null ? null : (s.leaves.find((x) => x.id === id) ?? null)));
  const can = useAppState((s) => myPerm(s, 'leave.approve'));
  const { decideLeave } = useActions();
  const decide = (st: 'approved' | 'rejected') => {
    if (!l) return;
    const r = decideLeave(l.id, st);
    onClose();
    toastResult(r);
  };
  return (
    <BottomSheet visible={!!l} title={l ? leaveKindLabel(l.kind) : ''} sub={l?.who} onClose={onClose} testID="sheet-approve">
      {l ? (
        <>
          <FieldList
            items={[
              { label: 'Dates', value: leaveDates(l) },
              { label: 'Days', value: String(l.days) },
              { label: 'Reason', value: l.reason },
              { label: 'Status', value: LEAVE_STATUS[l.st].label },
            ]}
          />
          {can && l.st === 'pending' ? (
            <ButtonRow>
              <Button title="Reject" icon="x" kind="d" onPress={() => decide('rejected')} testID="approve-reject" />
              <Button title="Approve" icon="check" kind="g" onPress={() => decide('approved')} testID="approve-approve" />
            </ButtonRow>
          ) : null}
          {can ? null : <TextBlock tone="info" text="Admins approve leave." />}
        </>
      ) : null}
    </BottomSheet>
  );
}
