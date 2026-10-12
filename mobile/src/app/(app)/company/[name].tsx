import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '@/components/Placeholder';

/**
 * S-COMPANY Company detail. Title is the company name.
 * Placeholder: P4 replaces this file (src/app/(app)/company/[name].tsx).
 */
export default function CompanyScreen() {
  const { name = '' } = useLocalSearchParams<{ name: string }>();
  return (
    <Placeholder
      screen="S-COMPANY"
      title={name}
      owner="P4"
      file="src/app/(app)/company/[name].tsx"
      params={{ name }}
      testID="screen-company"
    />
  );
}
