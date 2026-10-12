import { myRole } from '@/data/selectors';
import { useAppState } from '@/data/store';
import { UsersScreen } from '@/features/admin/UsersScreen';
import { ClientTeamScreen } from '@/features/client/ClientTeamScreen';

/** S5-USERS Users (W3); cadmin gets "Your team" (W4 embed). */
export default function UsersRoute() {
  const role = useAppState(myRole);
  if (role === 'cadmin') return <ClientTeamScreen />;
  return <UsersScreen />;
}
