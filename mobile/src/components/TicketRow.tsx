import { PRIORITY_DOT, TICKET_STATUS } from '@/data/constants';
import { dueInfo, epicName, isClient, project, subProgress } from '@/data/selectors';
import { actions, useAppState } from '@/data/store';
import type { Ticket } from '@/data/types';
import { href, push } from '@/nav/routes';
import { colors } from '@/theme';

import { Row, type RowProps } from './Row';

/** Open a ticket (V-20): clears its unread count for staff, then pushes the detail. */
export function openTicket(key: string): void {
  actions.markTicketRead(key);
  push(href.ticket(key));
}

export interface TicketRowProps {
  ticket: Ticket;
  /** sub line override (default "Project · Epic") */
  sub?: string;
  /** default: openTicket(key) */
  onPress?: () => void;
  /** extra Row props (bg for the current row, chevron off in pick lists) */
  row?: Partial<RowProps>;
  testID?: string;
}

/**
 * The ticket row used everywhere (`tRow`, S5-MYTICKETS): priority dot, mono key, title
 * (grey when done), "Project · Epic", meta (subtasks with a mini bar, unread or comment
 * count, due), status badge (client labels for clients), chevron.
 */
export function TicketRow({ ticket: t, sub, onPress, row, testID }: TicketRowProps) {
  const client = useAppState(isClient);
  const projectName = useAppState((s) => project(s, t.projectId)?.name ?? '');
  const epic = useAppState((s) => epicName(s, t.epicId));
  const st = TICKET_STATUS[t.st];
  const { done, total } = subProgress(t);
  const due = dueInfo(t);
  return (
    <Row
      dot={PRIORITY_DOT[t.prio]}
      monoKey={t.key}
      title={t.title}
      label={`${t.key} ${t.title}`}
      titleColor={t.st === 'done' ? colors.ink3 : colors.ink}
      sub={sub ?? `${projectName} · ${epic}`}
      meta={[
        total ? { icon: 'list-checks', text: `${done} of ${total}`, bar: Math.round((done / total) * 100) } : null,
        t.unread && !client
          ? { icon: 'message-square', text: String(t.unread), color: colors.primaryInk, bold: true }
          : t.comments.length
            ? { icon: 'message-square', text: String(t.comments.length) }
            : null,
        { icon: 'calendar', text: due.text, color: due.color, bold: due.late },
      ]}
      badge={{ label: client ? st.client : st.label, tone: st.tone }}
      onPress={onPress ?? (() => openTicket(t.key))}
      testID={testID ?? `ticket-row-${t.key}`}
      {...row}
    />
  );
}
