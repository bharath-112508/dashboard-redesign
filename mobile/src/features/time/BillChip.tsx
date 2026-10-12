import { Chip } from '@/components/Chips';
import { colors } from '@/theme';

/** "Billable" (blue) or "Non-bill" (amber) chip on time entries. */
export function BillChip({ bill }: { bill: boolean }) {
  return bill ? (
    <Chip label="Billable" bg={colors.primarySoft2} fg={colors.primaryInk} />
  ) : (
    <Chip label="Non-bill" bg={colors.amberSoft} fg={colors.amberInk} />
  );
}
