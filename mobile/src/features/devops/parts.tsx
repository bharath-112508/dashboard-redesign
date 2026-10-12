import { Block, IconTile, Row, Rows, Timeline, type TimelineItem } from '@/components';
import { DEPLOYS } from '@/data/seed';
import type { DevopsProject, DevopsRequest } from '@/data/types';
import { href, push } from '@/nav/routes';
import { colors } from '@/theme';

import { requestTone } from './board';

/** A DevOps request row (`reqRow`): pull-request tile, REQ key, text, type · by · when · to. */
export function RequestRow({ r }: { r: DevopsRequest }) {
  return (
    <Row
      lead={<IconTile icon="git-pull-request" bg={colors.devopsSoft} fg={colors.devopsInk} />}
      monoKey={r.rkey}
      title={r.text}
      label={`${r.rkey} ${r.text}`}
      sub={`${r.type} · raised by ${r.by} · ${r.when}${r.to ? ` · to ${r.to}` : ''}`}
      badge={{ label: r.status === 'Done' ? 'Done' : r.prio, tone: requestTone(r) }}
      meta={r.comments.length ? [{ icon: 'message-square', text: String(r.comments.length) }] : []}
      onPress={() => push(href.request(r.id))}
      testID={`request-row-${r.rkey}`}
    />
  );
}

export function RequestRows({ requests, empty, testID = 'requests' }: { requests: DevopsRequest[]; empty: string; testID?: string }) {
  return (
    <Rows empty={empty} testID={testID}>
      {requests.map((r) => (
        <RequestRow key={r.id} r={r} />
      ))}
    </Rows>
  );
}

/** Deployments timeline (`deploySec`): green live, red rolled back; empty hint about CI/CD. */
export function DeploymentsBlock({ d }: { d: Pick<DevopsProject, 'key' | 'cicd'> }) {
  const L = DEPLOYS[d.key] ?? [];
  const items: TimelineItem[] = L.length
    ? L.map((x) => {
        const ok = x.st === 'Live';
        return {
          dot: ok ? colors.green : colors.danger,
          ring: ok ? colors.greenSoft : colors.redSoft,
          k: x.v,
          kColor: ok ? colors.greenInk : colors.dangerInk,
          title: x.name + (ok ? '' : ' · rolled back'),
          sub: x.note,
          subColor: colors.dangerInk,
          right: x.when,
        };
      })
    : [
        {
          dot: colors.faint,
          ring: colors.track,
          title: 'No deployments reported yet',
          titleColor: colors.ink3,
          sub: d.cicd ? 'Each deploy from the CI/CD pipeline shows here.' : 'Switch on CI/CD to report deploys here.',
        },
      ];
  return (
    <Block title="Deployments" sub={L.length ? 'Green is live · red was rolled back' : undefined} testID="deployments">
      <Timeline items={items} />
    </Block>
  );
}
