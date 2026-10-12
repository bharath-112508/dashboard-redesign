import { useLocalSearchParams } from 'expo-router';

import { DevopsProjectScreen } from '@/features/devops/DevopsProjectScreen';

/** S5-DVP DevOps project (`?tab=`). */
export default function DevopsProjectRoute() {
  const { key, tab } = useLocalSearchParams<{ key?: string; tab?: string }>();
  return <DevopsProjectScreen key={key} dvKey={key ?? ''} tab={tab} />;
}
