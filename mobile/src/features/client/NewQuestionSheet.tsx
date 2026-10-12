import { useState } from 'react';

import { BottomSheet, Button, EmptyBlock, Form, SelectField, TextArea, TextBlock, TextField } from '@/components';
import { project, ticketsOf } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { closeSheet } from '@/nav/routes';

import { useFormErrors } from '../devops/formErrors';

/** SH-NEWQ "Raise to client" (URL sheet `new-question`, V-53); `title` prefills "Re: …". */
export function NewQuestionSheet({ pid, title: t0 }: { pid: string; title?: string }) {
  const p = useAppState((s) => project(s, pid));
  const open = useAppState((s) => ticketsOf(s, pid).filter((t) => t.st !== 'done'));
  const { createQuestion } = useActions();
  const fe = useFormErrors();
  const [title, setTitle] = useState(t0 ?? '');
  const [text, setText] = useState('');
  const [task, setTask] = useState('');
  if (!p) {
    return (
      <BottomSheet title="Raise to client" testID="sheet-new-question">
        <EmptyBlock text="Project not found." />
      </BottomSheet>
    );
  }
  const save = () => {
    if (!fe.need({ title, text })) return;
    if (fe.result(createQuestion({ projectId: p.id, title, text, task: task || null }))) closeSheet();
  };
  return (
    <BottomSheet title="Raise to client" sub={p.kind === 'client' ? `${p.co} · ${p.name}` : p.name} testID="sheet-new-question">
      <Form>
        <TextField label="Question" required value={title} onChange={setTitle} placeholder="Short summary" error={fe.errors.title} testID="newq-title" />
        <TextArea label="Details" required value={text} onChange={setText} placeholder="What do you need from the client?" error={fe.errors.text} testID="newq-text" />
        <SelectField
          label="Linked ticket"
          optional
          value={task}
          options={[{ value: '', label: 'None' }, ...open.map((t) => ({ value: t.key, label: `${t.key} · ${t.title}` }))]}
          onChange={setTask}
          testID="newq-task"
        />
      </Form>
      <TextBlock tone="info" text={'They see it in "Questions to client" in their portal.'} />
      <Button title="Raise question" onPress={save} testID="newq-save" />
    </BottomSheet>
  );
}
