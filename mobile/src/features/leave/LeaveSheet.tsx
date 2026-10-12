import { useState } from 'react';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Buttons';
import { DateField, Form, PickField, SelectField, TextArea } from '@/components/fields';
import { showToast } from '@/components/Toast';
import { TODAY } from '@/data/clock';
import { LEAVE_KINDS } from '@/data/constants';
import { me, myPerm } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { LeaveKind } from '@/data/types';
import { closeSheet, type SheetQuery } from '@/nav/routes';

/**
 * SH-LEAVE "Add leave" (V-73): Person (approvers only), Kind (web leave types), From*,
 * To*, Reason. Approvers add approved leave ("Leave added"); others send a pending
 * request ("Request sent for approval").
 */
export function LeaveSheet({ params }: { params: SheetQuery<'leave'> }) {
  const u = useAppState(me);
  const approver = useAppState((s) => myPerm(s, 'leave.approve'));
  const staff = useAppState((s) => s.people.filter((p) => p.org === 'vt').map((p) => p.name));
  const { addLeave } = useActions();
  const [who, setWho] = useState(params.who || u?.name || '');
  const [kind, setKind] = useState<LeaveKind>('Annual');
  const [from, setFrom] = useState(TODAY);
  const [to, setTo] = useState(TODAY);
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const save = () => {
    setTried(true);
    const r = addLeave({ who, kind, from, to, reason });
    if (!r.ok) {
      if (r.error !== 'Required') showToast(r.error);
      return;
    }
    closeSheet();
    showToast(r.toast);
  };
  return (
    <BottomSheet title="Add leave" testID="sheet-leave">
      <Form>
        {approver ? <SelectField label="Person" value={who} options={staff.map((n) => ({ value: n, label: n }))} onChange={setWho} testID="leave-who" /> : null}
        <PickField label="Kind" options={LEAVE_KINDS.map((k) => ({ value: k.kind, label: k.label }))} value={kind} onChange={setKind} testID="leave-kind" />
        <DateField label="From" required value={from} onChange={setFrom} error={tried && !from ? 'Required' : undefined} testID="leave-from" />
        <DateField label="To" required value={to} onChange={setTo} error={tried && !to ? 'Required' : undefined} testID="leave-to" />
        <TextArea label="Reason" optional value={reason} onChange={setReason} testID="leave-reason" />
      </Form>
      <Button title="Save" onPress={save} testID="leave-save" />
    </BottomSheet>
  );
}
