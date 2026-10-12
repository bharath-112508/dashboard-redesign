import { IconTile, Row } from '@/components';
import { TICKET_STATUS } from '@/data/constants';
import { fmtY } from '@/data/format';
import { isClient, myName, project } from '@/data/selectors';
import { useAppState } from '@/data/store';
import type { ClientBug, Question } from '@/data/types';
import { href, push } from '@/nav/routes';
import { colors } from '@/theme';

import { bugStatusLabel, bugTone } from './client';

/** Question row (`qRow`): Answered (green) / Waiting (amber); staff see the project in the sub. */
export function QuestionRow({ q }: { q: Question }) {
  const cl = useAppState(isClient);
  const pname = useAppState((s) => project(s, q.projectId)?.name ?? '');
  const answered = !!q.answer;
  return (
    <Row
      lead={<IconTile icon="message-circle-question" bg={answered ? colors.greenSoft : colors.amberSoft} fg={answered ? colors.greenInk : colors.amberInk} />}
      title={q.title}
      sub={`Asked by ${q.by}${cl ? '' : ` · ${pname}`} · ${q.when}`}
      badge={{ label: answered ? 'Answered' : 'Waiting', tone: answered ? 'green' : 'amber' }}
      onPress={() => push(href.question(q.id))}
      testID={`question-row-${q.id}`}
    />
  );
}

/** Bug row (`bugRow`): bug tile, title, "Reported by you/X · date", status (client labels for clients). */
export function BugRow({ b }: { b: ClientBug }) {
  const cl = useAppState(isClient);
  const me = useAppState(myName);
  return (
    <Row
      lead={<IconTile icon="bug" bg={colors.redSoft} fg={colors.dangerInk} />}
      title={b.title}
      sub={`Reported by ${b.by === me ? 'you' : b.by} · ${fmtY(b.when)}`}
      badge={{ label: cl ? bugStatusLabel(b.st) : TICKET_STATUS[b.st].label, tone: bugTone(b.st) }}
      onPress={() => push(href.bug(b.id))}
      testID={`bug-row-${b.id}`}
    />
  );
}
