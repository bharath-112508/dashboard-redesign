import { useLocalSearchParams } from 'expo-router';

import { UserScreen } from '@/features/admin/UserScreen';

/** S-USER User detail. Title is the person's name. */
export default function UserRoute() {
  const { name = '' } = useLocalSearchParams<{ name: string }>();
  return <UserScreen name={name} />;
}
