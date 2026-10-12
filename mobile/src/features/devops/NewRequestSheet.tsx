import { useState } from 'react';

import { BottomSheet, Button, EmptyBlock, Form, PickField, SelectField, TextArea, TextBlock } from '@/components';
import { DEVOPS_REQUEST_TYPES, PRIORITIES } from '@/data/constants';
import { devopsByKey } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { closeSheet } from '@/nav/routes';

import { useFormErrors } from './formErrors';

/** SH-NEWREQ (URL sheet `devops-request`, V-52): sub = the project name (DECISIONS 3). */
export function NewRequestSheet({ dvKey }: { dvKey: string }) {
  const d = useAppState((s) => devopsByKey(s, dvKey));
  const people = useAppState((s) => s.devopsSettings.people);
  const { createDevopsRequest } = useActions();
  const fe = useFormErrors();
  const [type, setType] = useState<string>('Deployment');
  const [prio, setPrio] = useState<string>('Medium');
  const [to, setTo] = useState(d && people.includes(d.owner) ? d.owner : 'Ganesh');
  const [text, setText] = useState('');
  if (!d) {
    return (
      <BottomSheet title="Send request" testID="sheet-devops-request">
        <EmptyBlock text="Project not found." />
      </BottomSheet>
    );
  }
  const send = () => {
    if (!fe.need({ text })) return;
    if (fe.result(createDevopsRequest({ key: d.key, type, prio, to, text }))) closeSheet();
  };
  return (
    <BottomSheet title="Send request" sub={d.name} testID="sheet-devops-request">
      <Form>
        <PickField label="Type" options={DEVOPS_REQUEST_TYPES.map((t) => ({ value: t as string, label: t }))} value={type} onChange={setType} testID="req-type" />
        <PickField label="Priority" options={PRIORITIES.map((t) => ({ value: t as string, label: t }))} value={prio} onChange={setPrio} testID="req-prio" />
        <SelectField label="Assign to" value={to} options={people.map((p) => ({ value: p, label: p }))} onChange={setTo} testID="req-to" />
        <TextArea label="What do you need?" required value={text} onChange={setText} error={fe.errors.text} testID="req-text" />
      </Form>
      <TextBlock tone="info" text="Requests show on the DevOps board on web and mobile." />
      <Button title="Send request" onPress={send} testID="req-send" />
    </BottomSheet>
  );
}
