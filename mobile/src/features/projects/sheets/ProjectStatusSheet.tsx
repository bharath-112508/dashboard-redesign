import { BottomSheet, EmptyBlock, PickList, toastResult } from '@/components';
import { project } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { ProjectState } from '@/data/types';
import { closeSheet } from '@/nav/routes';
import { tones } from '@/theme';

const OPTIONS: { value: ProjectState; label: string; sub: string; dot: string }[] = [
  { value: 'planned', label: 'Planned', sub: 'Not started yet', dot: tones.grey.dot },
  { value: 'active', label: 'Active', sub: 'Being built', dot: tones.blue.dot },
  { value: 'maint', label: 'Maintenance', sub: 'Live with a support agreement', dot: tones.teal.dot },
  { value: 'done', label: 'Completed', sub: 'Delivered and closed', dot: tones.green.dot },
];

/** SH-PROJSTATUS (V-42): tap a state to save it. */
export function ProjectStatusSheet({ id }: { id: string }) {
  const p = useAppState((s) => project(s, id));
  const { setProjectStatus } = useActions();
  return (
    <BottomSheet title="Project status" sub={p?.name} testID="sheet-project-status">
      {p ? (
        <PickList
          options={OPTIONS}
          value={p.state}
          onPick={(v) => {
            toastResult(setProjectStatus(p.id, v));
            closeSheet();
          }}
          testID="project-status"
        />
      ) : (
        <EmptyBlock text="Project not found." />
      )}
    </BottomSheet>
  );
}
