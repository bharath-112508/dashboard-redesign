import { useState } from 'react';

import { BottomSheet, Button, ButtonRow, DateField, EmptyBlock, Form, TextField, toastResult } from '@/components';
import { project } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { closeSheet } from '@/nav/routes';

/** SH-SUPTERMS (V-54): support until and hours per month, both required. */
export function SupportTermsSheet({ id }: { id: string }) {
  const p = useAppState((s) => project(s, id));
  const { saveSupportTerms } = useActions();
  const [until, setUntil] = useState(p?.sup?.until ?? '');
  const [quota, setQuota] = useState(p?.sup ? String(p.sup.quota) : '');
  const [tried, setTried] = useState(false);
  if (!p) {
    return (
      <BottomSheet title="Support terms" testID="sheet-support-terms">
        <EmptyBlock text="Project not found." />
      </BottomSheet>
    );
  }
  const save = () => {
    setTried(true);
    if (!until || !quota.trim()) return;
    if (toastResult(saveSupportTerms(p.id, until, quota))) closeSheet();
  };
  return (
    <BottomSheet title="Support terms" sub={p.name} testID="sheet-support-terms">
      <Form>
        <DateField label="Support until" required value={until} onChange={setUntil} error={tried && !until ? 'Required' : undefined} testID="terms-until-input" />
        <TextField
          label="Hours per month"
          required
          type="number"
          value={quota}
          onChange={(t) => setQuota(t.replace(/[^0-9.]/g, ''))}
          error={tried && !quota.trim() ? 'Required' : undefined}
          testID="terms-quota-input"
        />
      </Form>
      <ButtonRow>
        <Button title="Save terms" onPress={save} testID="terms-save" />
      </ButtonRow>
    </BottomSheet>
  );
}
