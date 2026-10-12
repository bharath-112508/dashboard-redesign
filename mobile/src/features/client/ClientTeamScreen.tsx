import { Avatar, Block, Button, Row, Rows, Screen, TextBlock } from '@/components';
import { clientTeamOf, me, orgName } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { openSheet } from '@/nav/routes';
import { useRootActions } from '@/nav/useRootActions';

/** S5-USERS client variant "Your team" (cadmin, rendered by the `users` route), V-64. */
export function ClientTeamScreen() {
  const u = useAppState(me);
  const org = useAppState((s) => (u ? orgName(s, u) : ''));
  const team = useAppState((s) => (u ? clientTeamOf(s, u.org) : []));
  const actions = useRootActions();
  const add = () => openSheet('client-member');
  return (
    <Screen title="Your team" sub={org} actions={actions} testID="screen-users">
      <TextBlock tone="info" text="They can report bugs and answer questions." />
      <Block title={`${team.length + 1} people`} sub={`${org} portal`} action="+ Add" onAction={add} actionTestID="team-add">
        <Rows testID="client-team">
          {u ? <Row lead={<Avatar name={u.name} />} title={`${u.name} (you)`} sub={u.email} badge={{ label: 'Client admin', tone: 'amber' }} testID="team-me" /> : null}
          {team.map((m) => (
            <Row
              key={m.id}
              lead={<Avatar name={m.name} />}
              title={m.name}
              sub={`${m.title} · ${m.email}`}
              onPress={() => openSheet('client-member', { email: m.email })}
              testID={`team-member-${m.id}`}
            />
          ))}
        </Rows>
      </Block>
      <Button title="Add someone from your team" icon="user-plus" onPress={add} testID="team-add-button" />
    </Screen>
  );
}
