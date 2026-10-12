import { useLocalSearchParams } from 'expo-router';

import { Placeholder } from '@/components/Placeholder';
import { sheetHref } from '@/nav/routes';

/**
 * S-PROJECT Project detail (all views). Title is the project name.
 * Placeholder: P3 replaces this file (src/app/(app)/project/[name].tsx).
 */
export default function ProjectScreen() {
  const { name = '' } = useLocalSearchParams<{ name: string }>();
  return (
    <Placeholder
      screen="S-PROJECT"
      title={name}
      owner="P3"
      file="src/app/(app)/project/[name].tsx"
      params={{ name }}
      links={[
        { label: 'Project status', href: sheetHref('project-status', { project: name }) },
        { label: 'Support plan', href: sheetHref('support-plan', { project: name }) },
        { label: 'Report a problem', href: sheetHref('report', { project: name, kind: 'Bug' }) },
        { label: 'Request a change', href: sheetHref('report', { project: name, kind: 'Change' }) },
        { label: 'Log time to support plan', href: sheetHref('log-time', { project: name, text: `${name} · support` }) },
      ]}
      testID="screen-project"
    />
  );
}
