import { PlaceholderScreen } from '@/components/Placeholder';
import { myRole } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { ClientTeamScreen } from '@/features/client/ClientTeamScreen';

/** S5-USERS Users (W3 replaces the staff branch); cadmin gets "Your team" (W4 embed). */
export default function UsersRoute() {
  const role = useAppState(myRole);
  if (role === 'cadmin') return <ClientTeamScreen />;
  return <PlaceholderScreen spec="S5-USERS Users" owner="W3" title="Users" sub="Workspace settings" id="users" />;
}
