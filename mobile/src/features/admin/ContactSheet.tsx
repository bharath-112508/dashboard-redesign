import { useState } from 'react';

import { BottomSheet } from '@/components/BottomSheet';
import { Button, ButtonRow } from '@/components/Buttons';
import { Form, PickField, TextField, ToggleField } from '@/components/fields';
import { showToast } from '@/components/Toast';
import { projectsOfCompany } from '@/data/selectors';
import { store, useActions, useAppState } from '@/data/store';
import { closeSheet, type SheetQuery } from '@/nav/routes';

/**
 * SH-CONTACT "Add a contact" / "Client contact" (V-82): name, role, email, portal
 * admin, projects seen in the portal; Remove on edit.
 */
export function ContactSheet({ params }: { params: SheetQuery<'contact'> }) {
  const co = params.co ?? '';
  const index = params.i != null && params.i !== '' ? Number(params.i) : null;
  const company = useAppState((s) => s.companies.find((c) => c.id === co) ?? null);
  const projects = useAppState((s) => projectsOfCompany(s, co));
  const [init] = useState(() => (index != null ? store.getState().companies.find((c) => c.id === co)?.contacts[index] : undefined));
  const edit = !!init;
  const { saveContact, removeContact } = useActions();
  const [name, setName] = useState(init?.name ?? '');
  const [role, setRole] = useState(init?.role ?? '');
  const [email, setEmail] = useState(init?.email ?? '');
  const [admin, setAdmin] = useState(!!init?.admin);
  const [sees, setSees] = useState<string[]>(init?.projects ? [...init.projects] : []);
  const [tried, setTried] = useState(false);
  const save = () => {
    setTried(true);
    const r = saveContact(co, edit ? index : null, { name, role, email, admin, projects: sees });
    if (!r.ok) {
      if (r.error !== 'Required') showToast(r.error);
      return;
    }
    closeSheet();
    showToast(r.toast);
  };
  const remove = () => {
    if (index == null) return;
    const r = removeContact(co, index);
    closeSheet();
    if (!r.ok) showToast(r.error);
  };
  return (
    <BottomSheet title={edit ? 'Client contact' : 'Add a contact'} sub={company?.name} testID="sheet-contact">
      <Form>
        <TextField label="Name" required value={name} onChange={setName} error={tried && !name.trim() ? 'Required' : undefined} testID="contact-name" />
        <TextField label="Role" optional value={role} onChange={setRole} placeholder="e.g. CTO" testID="contact-role" />
        <TextField label="Email" required type="email" value={email} onChange={setEmail} error={tried && !email.trim() ? 'Required' : undefined} testID="contact-email" />
        <ToggleField title="Admin in client portal" sub="Admins see everything on their projects." value={admin} onChange={setAdmin} testID="contact-admin" />
        <PickField
          label="Can see in the portal"
          multi
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
          values={sees}
          onChange={setSees}
          hint={projects.length ? undefined : 'This company has no projects yet.'}
          testID="contact-projects"
        />
      </Form>
      <ButtonRow>
        {edit ? <Button title="Remove" kind="d" onPress={remove} testID="contact-remove" /> : null}
        <Button title="Save" onPress={save} testID="contact-save" />
      </ButtonRow>
    </BottomSheet>
  );
}
