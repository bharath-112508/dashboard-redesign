import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet } from '@/components/BottomSheet';
import { PrimaryButton } from '@/components/Buttons';
import { SegmentedControl } from '@/components/Controls';
import { DateField, Field, FieldError, TextArea } from '@/components/fields';
import { showToast } from '@/components/Toast';
import { TODAY } from '@/data/clock';
import { addD } from '@/data/format';
import { useActions } from '@/data/store';
import type { LeaveType } from '@/data/types';
import { closeSheet } from '@/nav/routes';

/** S-LEAVESHEET New leave or comp-off request (M-35). Dates default to today + 7. */
export function LeaveSheet() {
  const [type, setType] = useState<LeaveType>('Leave');
  const [from, setFrom] = useState(() => addD(TODAY, 7));
  const [to, setTo] = useState(() => addD(TODAY, 7));
  const [reason, setReason] = useState('');
  const [err, setErr] = useState('');
  const { addLeave } = useActions();
  const comp = type === 'Comp-off';

  const save = () => {
    if (!reason.trim()) return setErr('Add a reason.');
    if (!from || !to || to < from) return setErr('The end date is before the start date.');
    addLeave({ type, from, to, reason });
    closeSheet();
    showToast('Request sent for approval');
  };

  return (
    <BottomSheet
      title="New request"
      icon="calendar-plus"
      testID="sheet-leave"
      footer={
        <>
          <FieldError text={err} />
          <PrimaryButton label="Send request" onPress={save} testID="leave-save" />
        </>
      }
    >
      <SegmentedControl
        label="Request type"
        value={type}
        onChange={(k) => setType(k)}
        segments={[
          { key: 'Leave', label: 'Leave' },
          { key: 'Comp-off', label: 'Comp-off' },
        ]}
        style={styles.seg}
      />
      <View style={styles.pair}>
        <Field label={comp ? 'Day worked' : 'From'} style={styles.flex}>
          <DateField
            label={comp ? 'Day worked' : 'From'}
            value={from}
            onChange={(v) => {
              setFrom(v);
              setErr('');
            }}
            testID="leave-from"
          />
        </Field>
        <Field label="To" style={styles.flex}>
          <DateField
            label="To"
            value={to}
            onChange={(v) => {
              setTo(v);
              setErr('');
            }}
            testID="leave-to"
          />
        </Field>
      </View>
      <Field label="Reason" required>
        <TextArea
          label="Reason"
          value={reason}
          onChangeText={(v) => {
            setReason(v);
            setErr('');
          }}
          placeholder={comp ? 'What did you work on that day?' : 'e.g. Family visit'}
          minHeight={90}
          testID="leave-reason"
        />
      </Field>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pair: { flexDirection: 'row', gap: 10 },
  seg: { height: 46 },
});
