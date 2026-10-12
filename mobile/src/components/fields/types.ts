export interface FieldBase {
  /** field label (also the accessible name) */
  label: string;
  /** red "*" after the label */
  required?: boolean;
  /** "(optional)" after the label */
  optional?: boolean;
  /** hint line (12, ink3) */
  hint?: string;
  /** error line (12.5/600 red); also turns the border red */
  error?: string;
  testID?: string;
}

export interface Option<V extends string = string> {
  value: V;
  label: string;
}

export interface SelectInputProps {
  label: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
  invalid?: boolean;
  testID?: string;
}

export interface DateInputProps {
  label: string;
  /** ISO day "YYYY-MM-DD" or '' */
  value: string;
  onChange: (iso: string) => void;
  invalid?: boolean;
  testID?: string;
}

/** A picked file: name and "14 KB"; `uri` is a data URL (image mode on web) or a file uri. */
export interface PickedFile {
  n: string;
  size: string;
  uri?: string;
}

export interface FileInputProps {
  label: string;
  /** image mode: scales to 200px (web) and previews the image */
  image?: boolean;
  accept?: string;
  onPick: (file: PickedFile) => void;
  testID?: string;
  children: React.ReactNode;
}
