import { useState } from 'react';

import { BottomSheet, Button, FileField, Form, SelectField, TextArea, TextField, type PickedFile } from '@/components';
import { epicsOf, isClient, projAll, projVis } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { closeSheet } from '@/nav/routes';

import { useFormErrors } from '../devops/formErrors';

/** SH-NEWBUG "Report a bug" (URL sheet `report-bug`, V-61). */
export function ReportBugSheet({ pid: pid0 }: { pid?: string }) {
  const cl = useAppState(isClient);
  const P = useAppState((s) => (cl ? projVis(s) : projAll(s)));
  const [pid, setPid] = useState(pid0 && P.some((p) => p.id === pid0) ? pid0 : (P[0]?.id ?? ''));
  const E = useAppState((s) => (pid ? epicsOf(s, pid) : []));
  const { reportBug } = useActions();
  const fe = useFormErrors();
  const [epic, setEpic] = useState('');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [file, setFile] = useState<PickedFile | null>(null);
  const area = E.some((e) => e.id === epic) ? epic : (E[0]?.id ?? '');
  const save = () => {
    if (!fe.need({ projectId: pid, title, desc })) return;
    if (fe.result(reportBug({ projectId: pid, epicId: area || undefined, title, desc, file: file ? { n: file.n, size: file.size } : null }))) closeSheet();
  };
  return (
    <BottomSheet title="Report a bug" sub="The team gets notified straight away" testID="sheet-report-bug">
      <Form>
        <SelectField label="Project" value={pid} options={P.map((p) => ({ value: p.id, label: p.name }))} onChange={setPid} error={fe.errors.projectId} testID="bug-project" />
        {E.length > 1 ? <SelectField label="Area" value={area} options={E.map((e) => ({ value: e.id, label: e.name }))} onChange={setEpic} testID="bug-area" /> : null}
        <TextField label="Title" required value={title} onChange={setTitle} placeholder="What went wrong?" error={fe.errors.title} testID="bug-title" />
        <TextArea label="What happened?" required value={desc} onChange={setDesc} placeholder="Steps, device, what you expected" error={fe.errors.desc} testID="bug-desc" />
        <FileField label="Photos & files" optional value={file} onPick={setFile} title="Add a screenshot" sub="PNG, JPG or PDF" accept="image/*,application/pdf" testID="bug-file" />
      </Form>
      <Button title="Send bug report" onPress={save} testID="bug-send" />
    </BottomSheet>
  );
}
