import { useState } from 'react';

import { Button, Rows, Screen, Segmented } from '@/components';
import { me, myName, orgName, projVis, visibleBugs } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { openSheet } from '@/nav/routes';
import { useRootActions } from '@/nav/useRootActions';

import { filterBugs, type BugFilter } from './client';
import { BugRow } from './rows';

/** S5-BUGS (clients tab): Report a bug, All (n) · Reported by me · Fixed (V-65). */
export function BugsScreen() {
  const B = useAppState(visibleBugs);
  const name = useAppState(myName);
  const first = useAppState((s) => projVis(s)[0]?.id);
  const org = useAppState((s) => {
    const u = me(s);
    return u ? orgName(s, u) : '';
  });
  const actions = useRootActions();
  const [v, setV] = useState<BugFilter>('all');
  const L = filterBugs(B, v, name);
  return (
    <Screen title="Bugs" sub={org} actions={actions} testID="screen-bugs">
      <Button title="Report a bug" icon="bug" onPress={() => openSheet('report-bug', first ? { pid: first } : {})} testID="bugs-report" />
      <Segmented
        options={[
          { value: 'all', label: 'All', count: B.length },
          { value: 'mine', label: 'Reported by me' },
          { value: 'done', label: 'Fixed' },
        ]}
        value={v}
        onChange={setV}
        testID="bugs-seg"
      />
      <Rows empty="No bugs here." testID="bugs">
        {L.map((b) => (
          <BugRow key={b.id} b={b} />
        ))}
      </Rows>
    </Screen>
  );
}
