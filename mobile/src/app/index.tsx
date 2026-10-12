import { Redirect } from 'expo-router';

import { me } from '@/data/selectors';
import { useAppState } from '@/data/store';

/** "/" → Home when signed in, otherwise Sign in. */
export default function Index() {
  const signedIn = useAppState((s) => !!me(s)?.role);
  return <Redirect href={signedIn ? '/home' : '/sign-in'} />;
}
