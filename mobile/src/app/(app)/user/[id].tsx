import { useLocalSearchParams } from 'expo-router';

import { UserScreen } from '@/features/admin/UserScreen';

/** S5-USER User (W3). */
export default function UserRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <UserScreen id={Number(id)} />;
}
