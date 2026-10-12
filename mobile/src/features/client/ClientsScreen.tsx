import { Block, CompanyTileById, Row, Rows, Screen, TextBlock } from '@/components';
import { plural } from '@/data/format';
import { useAppState } from '@/data/store';
import { href, push } from '@/nav/routes';
import { useRootActions } from '@/nav/useRootActions';
import { colors } from '@/theme';

import { clientSummaries } from './client';

/** S5-CLIENTS (super, admin, pm): client companies → their portal (staff view). */
export function ClientsScreen() {
  const L = useAppState(clientSummaries);
  const actions = useRootActions();
  return (
    <Screen title="Clients" sub="Client portals" actions={actions} root={false} testID="screen-clients">
      <TextBlock tone="info" text="Open a client to see what they see in their portal, raise questions and follow bugs." />
      <Block title={plural(L.length, 'client')}>
        <Rows empty="No clients yet." testID="clients">
          {L.map((x) => (
            <Row
              key={x.company.id}
              lead={<CompanyTileById id={x.company.id} />}
              title={x.company.name}
              sub={x.projectNames.join(', ')}
              meta={[
                { icon: 'message-circle-question', text: `${x.waiting} waiting`, color: x.waiting ? colors.amberInk : undefined, bold: !!x.waiting },
                { icon: 'bug', text: `${x.openBugs} open bugs` },
                { icon: 'users', text: `${x.contacts} contacts` },
              ]}
              onPress={() => push(href.portal(x.company.id))}
              testID={`client-row-${x.company.id}`}
            />
          ))}
        </Rows>
      </Block>
    </Screen>
  );
}
