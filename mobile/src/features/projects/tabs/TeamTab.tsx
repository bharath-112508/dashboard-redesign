import { useState } from 'react';

import { Avatar, Block, Row, Rows } from '@/components';
import { company, myCan, myPerm, personByName, roleLabel, ticketsOf, type ProjectView } from '@/data/selectors';
import { useAppState, useStoreState } from '@/data/store';
import { href, push } from '@/nav/routes';

import { TeamSheet } from '../sheets/TeamSheet';

/** Team tab (V-51, staff): team rows (open tickets), "+ Add" with `tickets.assign`, client contacts. */
export function TeamTab({ p }: { p: ProjectView }) {
  const state = useStoreState();
  const canAdd = useAppState((s) => myPerm(s, 'tickets.assign'));
  const canUsers = useAppState((s) => myCan(s, 'Users'));
  const [open, setOpen] = useState(false);
  const T = ticketsOf(state, p.id);
  const contacts = p.kind === 'client' ? (company(state, p.companyId)?.contacts ?? []).filter((c) => !c.projects?.length || c.projects.includes(p.id)) : [];
  return (
    <>
      <Block
        title={`${p.team.length} people`}
        sub={`${p.name} team`}
        action={canAdd ? '+ Add' : undefined}
        onAction={canAdd ? () => setOpen(true) : undefined}
        actionTestID="team-add"
      >
        <Rows empty="No team yet" testID="team-rows">
          {p.team.map((n) => {
            const u = personByName(state, n);
            const o = T.filter((t) => t.as.includes(n) && t.st !== 'done').length;
            const sub = u ? [roleLabel({ role: u.role, emp: undefined }), u.devType, u.emp === 'freelancer' ? 'Freelancer' : ''].filter(Boolean).join(' · ') : '';
            return (
              <Row
                key={n}
                lead={<Avatar name={n} />}
                title={n}
                sub={sub}
                right={`${o} open`}
                onPress={u && canUsers ? () => push(href.user(u.id)) : undefined}
                testID={`team-row-${n}`}
              />
            );
          })}
        </Rows>
      </Block>
      {p.kind === 'client' ? (
        <Block title="Client contacts" sub={p.co}>
          <Rows empty="Nobody added yet." testID="team-contacts">
            {contacts.map((c) => (
              <Row
                key={c.email}
                lead={<Avatar name={c.name} />}
                title={c.name}
                sub={`${c.role} · ${c.email}`}
                badge={c.admin ? { label: 'Portal admin', tone: 'amber' } : undefined}
              />
            ))}
          </Rows>
        </Block>
      ) : null}
      {open ? <TeamSheet projectId={p.id} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
