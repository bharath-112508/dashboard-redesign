import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '@/components/Placeholder';

/**
 * S-USER User detail. Title is the person's name.
 * Placeholder: P4 replaces this file (src/app/(app)/user/[name].tsx).
 */
export default function UserScreen() {
  const { name = '' } = useLocalSearchParams<{ name: string }>();
  return (
    <Placeholder
      screen="S-USER"
      title={name}
      owner="P4"
      file="src/app/(app)/user/[name].tsx"
      params={{ name }}
      testID="screen-user"
    />
  );
}
