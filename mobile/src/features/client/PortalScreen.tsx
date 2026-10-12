import { PlaceholderScreen } from '@/components/Placeholder';
import { me, orgName } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { useRootActions } from '@/nav/useRootActions';

/**
 * S5-PORTAL client view: the `projects` tab for cadmin/cuser. Embed placeholder: W4
 * fills it (the staff view is the `portal/[co]` route, also W4).
 */
export function PortalScreen() {
  const org = useAppState((s) => {
    const u = me(s);
    return u ? orgName(s, u) : '';
  });
  const actions = useRootActions();
  return <PlaceholderScreen spec="S5-PORTAL Client projects" owner="W4" title="Projects" sub={org} id="projects" actions={actions} />;
}
