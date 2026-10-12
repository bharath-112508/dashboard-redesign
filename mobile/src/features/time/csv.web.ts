/**
 * Hand a CSV to the user (M-42), web build: download the file, as in the prototype.
 * The iOS / Android version is csv.ts (writes a real .csv file and opens the share sheet).
 */
export async function shareCsv(filename: string, csv: string): Promise<boolean> {
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
