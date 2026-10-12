import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Share } from 'react-native';

/**
 * Hand a CSV to the user (M-42), iOS / Android: write a real .csv file to the cache
 * directory and open the system share sheet for it (Save to Files, Mail, Drive, …).
 * If file sharing is not available, share the CSV text instead.
 * The web build uses csv.web.ts (browser download).
 * Returns false when the export failed or the text share was dismissed.
 */
export async function shareCsv(filename: string, csv: string): Promise<boolean> {
  try {
    if (await Sharing.isAvailableAsync()) {
      const file = new File(Paths.cache, filename);
      if (file.exists) file.delete();
      file.create();
      file.write(csv);
      await Sharing.shareAsync(file.uri, {
        mimeType: 'text/csv',
        UTI: 'public.comma-separated-values-text',
        dialogTitle: filename,
      });
      return true;
    }
    const res = await Share.share({ title: filename, message: csv });
    return res.action !== Share.dismissedAction;
  } catch {
    return false;
  }
}
