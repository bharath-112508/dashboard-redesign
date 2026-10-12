import * as DocumentPicker from 'expo-document-picker';

import { Press } from '../Press';
import type { FileInputProps } from './types';

/** File picker (native): the system document picker. Web: FileInput.web.tsx. */
export function FileInput({ label, image, onPick, testID, children }: FileInputProps) {
  const pick = async () => {
    const res = await DocumentPicker.getDocumentAsync({ type: image ? 'image/*' : '*/*', copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    onPick({ n: a.name, size: `${Math.max(1, Math.round((a.size ?? 0) / 1024))} KB`, uri: a.uri });
  };
  return (
    <Press label={label} onPress={pick} testID={testID}>
      {children}
    </Press>
  );
}
