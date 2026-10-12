import { Avatar, IconTile } from '@/components/Avatar';
import { Row, type RowMeta } from '@/components/Row';
import { fmtL, hm } from '@/data/format';
import type { TimeEntry } from '@/data/types';
import { colors } from '@/theme';

/** The Billable / Non-billable meta line of an entry row. */
export const billMeta = (bill: boolean): RowMeta => ({
  icon: bill ? 'badge-dollar-sign' : 'circle-minus',
  text: bill ? 'Billable' : 'Non-billable',
  color: bill ? colors.primaryInk : colors.violetInk,
});

/**
 * My entry row (Timesheet Log and History): ticket / pen tile (blue billable, violet
 * otherwise; History rows have none), key, task, "Project · note" (or the date), hours. Tapping edits (V-12).
 */
export function EntryRow({ e, sub, keyText, onPress, weight = 800, tile = true }: { e: TimeEntry; sub: string; keyText: string; onPress?: () => void; weight?: 700 | 800; tile?: boolean }) {
  return (
    <Row
      lead={tile ? <IconTile icon={e.key ? 'ticket' : 'pen-line'} bg={e.bill ? colors.primarySoft : colors.violetSoft} fg={e.bill ? colors.primaryInk : colors.violetInk} /> : undefined}
      monoKey={keyText || undefined}
      title={e.task}
      sub={sub}
      right={hm(e.min)}
      rightColor={colors.ink}
      rightWeight={weight}
      meta={[billMeta(e.bill)]}
      label={`Edit ${hm(e.min)} on ${e.task}`}
      onPress={onPress}
      testID={`entry-${e.id}`}
    />
  );
}

/** A team entry row (Employee / Company timesheets): avatar, task, "Who · date · project", hours. */
export function TeamEntryRow({ e, project }: { e: TimeEntry; project: string }) {
  return (
    <Row
      lead={<Avatar name={e.who} />}
      title={e.task}
      sub={`${e.who} · ${fmtL(e.date)} · ${project}`}
      right={hm(e.min)}
      rightColor={colors.ink}
      rightWeight={700}
      meta={[billMeta(e.bill)]}
    />
  );
}
