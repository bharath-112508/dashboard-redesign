import { Platform, Share } from 'react-native';

/**
 * Hand a CSV to the user (M-42). Web: download the file, as in the prototype.
 * iOS / Android: the system share sheet with the CSV text (no extra native module).
 * Returns false when the user dismissed the share sheet or it failed.
 */
export async function shareCsv(filename: string, csv: string): Promise<boolean> {
  if (Platform.OS === 'web') {
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  try {
    const res = await Share.share({ title: filename, message: csv });
    return res.action !== Share.dismissedAction;
  } catch {
    return false;
  }
}
