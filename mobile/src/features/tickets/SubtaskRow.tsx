import { Row } from '@/components';
import { PRIORITY_DOT, TICKET_STATUS } from '@/data/constants';
import { diff, fmt, hm } from '@/data/format';
import { loggedMin, subOf } from '@/data/selectors';
import { TODAY } from '@/data/clock';
import { useActions, useAppState } from '@/data/store';
import { toastResult } from '@/components';
import { colors, tones } from '@/theme';

/**
 * A subtask row (`subRow`): left check box (toggles done for staff, V-24), mono key
 * PMT-11.2, title (struck through when done), meta: status, priority, due ("Overdue 7
 * Oct" in red), time "logged / est" (staff), assignee.
 */
export function SubtaskRow({
  id,
  editable,
  client,
  onPress,
  current,
}: {
  id: string;
  editable: boolean;
  client: boolean;
  onPress?: () => void;
  current?: boolean;
}) {
  const x = useAppState((s) => subOf(s, id));
  const lg = useAppState((s) => loggedMin(s, id));
  const { toggleSubtask } = useActions();
  if (!x) return null;
  const st = TICKET_STATUS[x.st];
  const d = x.due ? diff(x.due, TODAY) : null;
  const late = d != null && d < 0 && !x.done;
  const time = x.est ? `${hm(lg)} / ${x.est}h` : lg ? `${hm(lg)} logged` : 'No estimate';
  return (
    <Row
      check={{
        on: x.done,
        label: `${x.done ? 'Reopen' : 'Mark done'} ${x.key}`,
        onToggle: editable ? () => toastResult(toggleSubtask(x.parent.key, x.id)) : undefined,
      }}
      monoKey={x.key}
      title={x.title}
      label={`${x.key} ${x.title}`}
      strike={x.done}
      titleColor={x.done ? colors.ink3 : colors.ink}
      meta={[
        { icon: 'circle-dot', text: client ? st.client : st.label, color: tones[st.tone].ink, bold: true },
        { icon: 'signal-high', text: x.prio, color: PRIORITY_DOT[x.prio] },
        { icon: 'calendar', text: x.due ? `${late ? 'Overdue' : 'Due'} ${fmt(x.due)}` : 'No due date', color: late ? colors.danger : colors.ink3, bold: late },
        client ? null : { icon: 'clock-3', text: time, color: x.est && lg / 60 > x.est ? colors.destructiveInk : colors.ink3 },
        { icon: 'user-round', text: x.as || 'Unassigned', color: x.as ? colors.ink : colors.ink3 },
      ]}
      bg={current ? colors.rowSelected : undefined}
      onPress={onPress}
      chevron={!!onPress}
      testID={`sub-row-${x.id}`}
    />
  );
}
