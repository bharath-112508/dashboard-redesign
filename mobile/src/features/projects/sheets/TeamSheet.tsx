import { useState } from 'react';

import { BottomSheet, Button, ButtonRow, Form, PickField, toastResult } from '@/components';
import { activeStaff, project } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';

/** SH-TEAM (V-51): multi-pick of active staff, Save team. */
export function TeamSheet({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { saveProjectTeam } = useActions();
  const staff = useAppState(activeStaff);
  const current = useAppState((s) => project(s, projectId)?.team ?? []);
  const [team, setTeam] = useState<string[]>(current);
  const names = [...new Set([...staff.map((u) => u.name), ...current])];
  return (
    <BottomSheet visible title="Team" sub="They can be assigned to tickets and sprints." onClose={onClose} testID="sheet-team">
      <Form>
        <PickField label="" multi values={team} onChange={setTeam} options={names.map((n) => ({ value: n, label: n }))} testID="team-pick" />
      </Form>
      <ButtonRow>
        <Button
          title="Save team"
          onPress={() => {
            if (toastResult(saveProjectTeam(projectId, team))) onClose();
          }}
          testID="team-save"
        />
      </ButtonRow>
    </BottomSheet>
  );
}
