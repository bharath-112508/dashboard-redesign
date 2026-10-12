import { Block, FieldList, TextBlock } from '@/components';
import { dvDate } from '@/data/format';
import { devopsFor, requestsFor } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { openSheet } from '@/nav/routes';
import { colors, tones } from '@/theme';

import { devopsTone } from './board';
import { DeploymentsBlock, RequestRows } from './parts';

/**
 * Project page → DevOps tab body (S5-PROJECT DevOps, staff). W2 mounts it. The record is
 * looked up by `projectId` only (DECISIONS 3). Read-only fields, deployments, and the
 * project's requests with "+ Send request" (V-52).
 */
export function ProjectDevopsTab({ projectId }: { projectId: string }) {
  const d = useAppState((s) => devopsFor(s, projectId));
  const reqs = useAppState((s) => (d ? requestsFor(s, d.key) : []));
  if (!d) return <TextBlock tone="info" text="This project is not on the DevOps board yet." testID="project-devops-none" />;
  return (
    <>
      <Block title="DevOps" sub="Read only · updated by the DevOps team" testID="project-devops">
        <FieldList
          items={[
            { label: 'Status', value: d.infra, dot: tones[devopsTone(d.infra)].dot },
            { label: 'Dev phase', value: d.dev },
            { label: 'Deployment', value: d.deploy },
            { label: 'CI/CD', value: d.cicd ? 'On · deploys automatically' : 'Off', dot: d.cicd ? colors.green : colors.faint },
            { label: 'DevOps owner', value: d.owner },
            { label: 'Estimated deployment', value: dvDate(d.latestDue || d.initDue) },
          ]}
        />
      </Block>
      <DeploymentsBlock d={d} />
      <Block title="Requests" sub="Raised from this project" action="+ Send request" onAction={() => openSheet('devops-request', { key: d.key })} actionTestID="project-send-request">
        <RequestRows requests={reqs} empty="No requests yet." testID="project-requests" />
      </Block>
    </>
  );
}
