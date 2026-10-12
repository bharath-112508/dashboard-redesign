import { useState } from 'react';

import { BottomSheet, Button, ButtonRow, DateField, Form, PickField, Segmented, SelectField, TextArea, TextField, showToast } from '@/components';
import { AREAS } from '@/data/constants';
import { activeStaff } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { ProjectKind } from '@/data/types';
import { closeSheet, href, push } from '@/nav/routes';

/**
 * SH-NEWPROJECT (V-41): for a client (company) or internal (area); name required.
 * Opened from Projects "+" or a company's "+ Start new project" (`co` preset hides the segment).
 */
export function NewProjectSheet({ co }: { co?: string }) {
  const { createProject } = useActions();
  const companies = useAppState((s) => s.companies.filter((c) => !c.archived));
  const staff = useAppState(activeStaff);
  const [kind, setKind] = useState<ProjectKind>('client');
  const [companyId, setCompanyId] = useState(co ?? '');
  const [area, setArea] = useState<string>(AREAS[0]);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [start, setStart] = useState('');
  const [due, setDue] = useState('');
  const [team, setTeam] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const isClientKind = co ? true : kind === 'client';
  const missName = !name.trim();
  const missCo = isClientKind && !companyId;

  const save = () => {
    setTried(true);
    if (missName || missCo) return;
    const r = createProject({ kind: isClientKind ? 'client' : 'internal', companyId, area, name, desc, start, due, team });
    if (!r.ok) return showToast(r.error);
    showToast(r.toast);
    closeSheet();
    push(href.project(r.id));
  };

  return (
    <BottomSheet title="Start a project" testID="sheet-new-project">
      {co ? null : (
        <Segmented
          options={[
            { value: 'client', label: 'For a client' },
            { value: 'internal', label: 'Internal' },
          ]}
          value={kind}
          onChange={setKind}
          testID="new-project-kind"
        />
      )}
      <Form>
        {isClientKind ? (
          <SelectField
            label="Company"
            required
            value={companyId}
            options={[{ value: '', label: 'Choose a company' }, ...companies.map((c) => ({ value: c.id, label: c.name }))]}
            onChange={setCompanyId}
            error={tried && missCo ? 'Required' : undefined}
            testID="new-project-company"
          />
        ) : (
          <SelectField label="Area" value={area} options={AREAS.map((a) => ({ value: a, label: a }))} onChange={setArea} testID="new-project-area" />
        )}
        <TextField label="Project name" required value={name} onChange={setName} placeholder="e.g. Customer app" error={tried && missName ? 'Required' : undefined} testID="new-project-name" />
        <TextArea label="What are we building?" optional value={desc} onChange={setDesc} testID="new-project-desc" />
        <DateField label="Start date" optional value={start} onChange={setStart} testID="new-project-start" />
        <DateField label="Deadline" optional value={due} onChange={setDue} testID="new-project-due" />
        <PickField label="Team" optional multi values={team} onChange={setTeam} options={staff.map((u) => ({ value: u.name, label: u.name }))} testID="new-project-team" />
      </Form>
      <ButtonRow>
        <Button title="Start project" onPress={save} testID="new-project-save" />
      </ButtonRow>
    </BottomSheet>
  );
}
