import { useState } from 'react';

import { BottomSheet } from '@/components/BottomSheet';
import { Button } from '@/components/Buttons';
import { FileField, Form, SelectField, TextArea, TextField, type PickedFile } from '@/components/fields';
import { showToast } from '@/components/Toast';
import { COUNTRIES } from '@/data/constants';
import { store, useActions } from '@/data/store';
import { closeSheet, href, push, type SheetQuery } from '@/nav/routes';

/**
 * SH-COMPANY "Add a company" / "Edit company" (V-80, V-81). Add opens the new company;
 * edit toasts "Saved".
 */
export function CompanySheet({ params }: { params: SheetQuery<'company'> }) {
  const [init] = useState(() => (params.id ? store.getState().companies.find((c) => c.id === params.id) : undefined));
  const edit = !!init;
  const { createCompany, updateCompany } = useActions();
  const [name, setName] = useState(init?.name ?? '');
  const [logo, setLogo] = useState<PickedFile | null>(init?.logo ? { n: 'logo', size: '', uri: init.logo } : null);
  const [industry, setIndustry] = useState(init?.industry ?? '');
  const [country, setCountry] = useState(init?.country || 'Norway');
  const [web, setWeb] = useState(init?.web ?? '');
  const [notes, setNotes] = useState(init?.notes ?? '');
  const [contact, setContact] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [tried, setTried] = useState(false);
  const save = () => {
    setTried(true);
    if (init) {
      const r = updateCompany(init.id, { name, logo: logo?.uri ?? init.logo, industry, country, web, notes });
      if (!r.ok) {
        if (r.error !== 'Required') showToast(r.error);
        return;
      }
      closeSheet();
      showToast(r.toast);
      return;
    }
    const r = createCompany({ name, logo: logo?.uri, industry, country, web, contact: contact.trim() || undefined, contactEmail: contactEmail.trim() });
    if (!r.ok) {
      if (r.error !== 'Required') showToast(r.error);
      return;
    }
    closeSheet();
    push(href.company(r.id));
    showToast(r.toast);
  };
  return (
    <BottomSheet title={edit ? 'Edit company' : 'Add a company'} testID="sheet-company">
      <Form>
        <TextField label="Company name" required value={name} onChange={setName} error={tried && !name.trim() ? 'Required' : undefined} testID="company-name" />
        <FileField
          label="Company logo"
          optional
          image
          accept="image/*"
          title="Upload logo"
          sub="PNG or SVG works best. Shown wherever this company appears."
          value={logo}
          onPick={setLogo}
          testID="company-logo"
        />
        <TextField label="Industry" optional value={industry} onChange={setIndustry} testID="company-industry" />
        <SelectField label="Country" value={country} options={COUNTRIES.map((c) => ({ value: c, label: c }))} onChange={setCountry} testID="company-country" />
        <TextField label="Website" optional value={web} onChange={setWeb} placeholder="company.com" testID="company-web" />
        {edit ? (
          <TextArea label="About" optional value={notes} onChange={setNotes} testID="company-notes" />
        ) : (
          <>
            <TextField label="Main contact" optional value={contact} onChange={setContact} testID="company-contact" />
            <TextField label="Contact email" optional type="email" value={contactEmail} onChange={setContactEmail} testID="company-contact-email" />
          </>
        )}
      </Form>
      <Button title={edit ? 'Save' : 'Create company'} onPress={save} testID="company-save" />
    </BottomSheet>
  );
}
