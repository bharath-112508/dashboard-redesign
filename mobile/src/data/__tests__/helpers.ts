import { createCommands } from '../store/commands';
import { reducer } from '../store/reducer';
import { createInitialState, type AppState } from '../store/state';

/** A store-less harness: state + commands, signed in as `personId` (default Rahul). */
export function harness(personId: number | null = 1) {
  let state: AppState = { ...createInitialState(), session: { personId } };
  const get = () => state;
  const cmd = createCommands(get, (a) => {
    state = reducer(state, a);
  });
  return { get, cmd, as: (id: number | null) => (state = { ...state, session: { personId: id } }) };
}
