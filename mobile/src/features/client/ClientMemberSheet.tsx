import { useState } from 'react';

import { BottomSheet, Button, ButtonRow, Form, TextField, showToast } from '@/components';
import { clientTeamOf, me } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { closeSheet } from '@/nav/routes';

import { useFormErrors } from '../devops/formErrors';

/** SH-CMEMBER (URL sheet `client-member`, V-64): add, edit (by email) or remove a team member. */
export function ClientMemberSheet({ email }: { email?: string }) {
  const ex = useAppState((s) => {
    const u = me(s);
    return email && u ? (clientTeamOf(s, u.org).find((m) => m.email === email) ?? null) : null;
  });
  const { saveClientMember, removeClientMember } = useActions();
  const fe = useFormErrors();
  const [name, setName] = useState(ex?.name ?? '');
  const [title, setTitle] = useState(ex?.title ?? '');
  const [mail, setMail] = useState(ex?.email ?? '');
  const save = () => {
    if (!fe.need({ name, title, email: mail })) return;
    const r = saveClientMember({ id: ex?.id, name, title, email: mail });
    if (!r.ok) {
      showToast(r.error);
      return;
    }
    showToast(r.toast);
    closeSheet();
  };
  return (
    <BottomSheet title={ex ? 'Team member' : 'Add someone from your team'} sub="They can report bugs and answer questions." testID="sheet-client-member">
      <Form>
        <TextField label="Name" required value={name} onChange={setName} error={fe.errors.name} testID="member-name" />
        <TextField label="Job title" required value={title} onChange={setTitle} error={fe.errors.title} testID="member-title" />
        <TextField label="Email" required type="email" value={mail} onChange={setMail} error={fe.errors.email} testID="member-email" />
      </Form>
      <ButtonRow>
        {ex ? (
          <Button
            title="Remove"
            kind="d"
            onPress={() => {
              const r = removeClientMember(ex.id);
              if (!r.ok) showToast(r.error);
              else closeSheet();
            }}
            testID="member-remove"
          />
        ) : null}
        <Button title={ex ? 'Save' : 'Add member'} onPress={save} testID="member-save" />
      </ButtonRow>
    </BottomSheet>
  );
}
