import { useState } from 'react';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Buttons';
import { Field, Form, PickField, SelectField, TextField, ToggleField } from '@/components/fields';
import { showToast } from '@/components/Toast';
import { DEVTYPES, ROLE_LABEL, ROLES } from '@/data/constants';
import { isClientRole, projAll } from '@/data/selectors';
import { store, useActions, useAppState } from '@/data/store';
import type { Role } from '@/data/types';
import { closeSheet, type SheetQuery } from '@/nav/routes';

import { accessFrom } from './admin';

const SUPER_HINT = 'Super admins always have access to every project, including new ones.';

/**
 * SH-USER "Add user" / "Edit user" (V-71): name, email, user type, developer type,
 * employment, project access, account active. Duplicate email → toast.
 */
export function UserSheet({ params }: { params: SheetQuery<'user'> }) {
  const id = params.id ? Number(params.id) : undefined;
  const [init] = useState(() => (id != null ? store.getState().people.find((p) => p.id === id) : undefined));
  const edit = !!init;
  const projects = useAppState(projAll);
  const { saveUser } = useActions();
  const [name, setName] = useState(init?.name ?? '');
  const [email, setEmail] = useState(init?.email ?? '');
  const [role, setRole] = useState<Role>(init?.role ?? 'dev');
  const [devType, setDevType] = useState(init?.devType ?? '');
  const [emp, setEmp] = useState<'employee' | 'freelancer'>(init?.emp ?? 'employee');
  const [access, setAccess] = useState<string[]>(init ? (init.projects === 'all' ? ['all'] : [...init.projects]) : []);
  const [active, setActive] = useState(init?.active ?? true);
  const [tried, setTried] = useState(false);
  const client = isClientRole(role);
  const save = () => {
    setTried(true);
    const r = saveUser({ id, name, email, role, devType, emp, projects: accessFrom(access), active, org: init?.org });
    if (!r.ok) {
      if (r.error !== 'Required') showToast(r.error);
      return;
    }
    closeSheet();
    showToast(r.toast);
  };
  return (
    <BottomSheet title={edit ? 'Edit user' : 'Add user'} testID="sheet-user">
      <Form>
        <TextField label="Full name" required value={name} onChange={setName} error={tried && !name.trim() ? 'Required' : undefined} testID="user-name" />
        <TextField label="Email" required type="email" value={email} onChange={setEmail} error={tried && !email.trim() ? 'Required' : undefined} testID="user-email" />
        <SelectField label="User type" value={role} options={ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} onChange={(v) => setRole(v as Role)} testID="user-role" />
        {client ? null : (
          <SelectField
            label="Developer type"
            optional
            value={devType}
            options={[{ value: '', label: 'None' }, ...DEVTYPES.map((d) => ({ value: d, label: d }))]}
            onChange={setDevType}
            testID="user-devtype"
          />
        )}
        {client ? null : (
          <PickField
            label="Employment"
            options={[
              { value: 'employee', label: 'Employee' },
              { value: 'freelancer', label: 'Freelancer' },
            ]}
            value={emp}
            onChange={setEmp}
            hint={emp === 'freelancer' ? 'Freelancers log time without idle time.' : undefined}
            testID="user-emp"
          />
        )}
        {role === 'super' ? (
          <Field label="Project access" hint={SUPER_HINT}>
            {null}
          </Field>
        ) : (
          <PickField
            label="Project access"
            multi
            options={[{ value: 'all', label: 'All projects' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
            values={access}
            onChange={setAccess}
            hint={SUPER_HINT}
            testID="user-access"
          />
        )}
        <ToggleField title="Account active" sub="Deactivated users can't sign in. Their history is kept." value={active} onChange={setActive} testID="user-active-toggle" />
      </Form>
      <Button title={edit ? 'Save' : 'Add user'} onPress={save} testID="user-save" />
    </BottomSheet>
  );
}
