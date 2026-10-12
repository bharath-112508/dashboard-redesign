import { Dot } from './Bits';
import { Row, Rows } from './Row';

export interface PickOption<V extends string = string> {
  value: V;
  label: string;
  sub?: string;
  /** dot colour before the label */
  dot?: string;
}

/**
 * Pick list (SPEC §5 sheets, the prototype's `pick`): rows with a right check box; the
 * current value is checked. Tapping a row calls `onPick` (sheets save and close).
 */
export function PickList<V extends string>({ options, value, onPick, testID = 'pick' }: { options: PickOption<V>[]; value: V | null | undefined; onPick: (v: V) => void; testID?: string }) {
  return (
    <Rows testID={testID}>
      {options.map((o) => (
        <Row
          key={o.value}
          title={o.label}
          sub={o.sub}
          lead={undefined}
          dot={o.dot}
          picked={o.value === value}
          onPress={() => onPick(o.value)}
          testID={`${testID}-${o.value || 'none'}`}
        />
      ))}
    </Rows>
  );
}

