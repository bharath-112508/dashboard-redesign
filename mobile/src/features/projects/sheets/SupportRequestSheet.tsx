import { useState } from 'react';

import { BottomSheet, Button, ButtonRow, EmptyBlock, Form, PickField, TextArea, TextBlock, TextField, toastResult } from '@/components';
import { project } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { TicketPrio } from '@/data/types';
import { closeSheet } from '@/nav/routes';

const SEVERITY: { value: TicketPrio; label: string }[] = [
  { value: 'Critical', label: 'Down for everyone' },
  { value: 'High', label: 'Blocks some users' },
  { value: 'Medium', label: 'Annoying' },
  { value: 'Low', label: 'Cosmetic' },
];

/** SH-SUPREQ (V-55): client "Report a problem" / "Request a change" → a support ticket. */
export function SupportRequestSheet({ pid, kind }: { pid: string; kind: 'problem' | 'change' }) {
  const p = useAppState((s) => project(s, pid));
  const { createSupportRequest } = useActions();
  const problem = kind === 'problem';
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [prio, setPrio] = useState<TicketPrio>('High');
  const [tried, setTried] = useState(false);
  const heading = problem ? 'Report a problem' : 'Request a change';
  if (!p) {
    return (
      <BottomSheet title={heading} testID="sheet-support-request">
        <EmptyBlock text="Project not found." />
      </BottomSheet>
    );
  }
  const send = () => {
    setTried(true);
    if (!title.trim() || !desc.trim()) return;
    if (toastResult(createSupportRequest({ projectId: p.id, kind, title, desc, prio: problem ? prio : undefined }))) closeSheet();
  };
  return (
    <BottomSheet title={heading} sub={p.name} testID="sheet-support-request">
      <Form>
        <TextField
          label="Title"
          required
          value={title}
          onChange={setTitle}
          placeholder={problem ? 'What is not working?' : 'What should change?'}
          error={tried && !title.trim() ? 'Required' : undefined}
          testID="supreq-title"
        />
        <TextArea label="Details" required value={desc} onChange={setDesc} error={tried && !desc.trim() ? 'Required' : undefined} testID="supreq-desc" />
        {problem ? <PickField label="How bad is it?" value={prio} onChange={setPrio} options={SEVERITY} testID="supreq-prio" /> : null}
      </Form>
      <TextBlock tone="info" text={problem ? 'Critical problems get a response within 4 hours.' : 'Changes use support hours from your monthly quota.'} />
      <ButtonRow>
        <Button title="Send" onPress={send} testID="supreq-send" />
      </ButtonRow>
    </BottomSheet>
  );
}
