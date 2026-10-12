export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectFieldProps {
  /** accessible name (the field label) */
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** blue border */
  highlight?: boolean;
  /** larger value (16/700, Hours and Minutes); default 15/600 as the prototype selects */
  strong?: boolean;
  testID?: string;
}

export interface DateFieldProps {
  label: string;
  /** ISO day "YYYY-MM-DD" or '' */
  value: string;
  onChange: (iso: string) => void;
  testID?: string;
}
