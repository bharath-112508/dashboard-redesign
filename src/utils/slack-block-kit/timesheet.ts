import { ERROR_CODES } from '../../constants/error-codes.js';
import { TIMESHEET_GENERAL_CATEGORIES, TIMESHEET_GENERAL_CATEGORY_MAX } from '../../constants/timesheet.js';
import {
    SLACK_BLOCK_TS_BILLABLE,
    SLACK_BLOCK_TS_CONTEXT,
    SLACK_BLOCK_TS_DATE,
    SLACK_BLOCK_TS_DESCRIPTION,
    SLACK_BLOCK_TS_NON_BILLABLE,
    SLACK_BLOCK_TS_PROJECT,
    SLACK_BLOCK_TS_TICKET,
    SLACK_BLOCK_TS_TYPE,
    SLACK_CALLBACK_LOG_TIME,
    SLACK_SELECT_OPTION_CAP,
    SLACK_SELECT_OPTION_LABEL_MAX,
    SLACK_TS_TYPE_GENERAL,
    SLACK_TS_TYPE_TICKET,
} from '../../constants/slack.js';

/**
 * Block Kit for the "Log time" modal.
 *
 * Pure — no I/O, no Slack calls. The caller supplies the project list and
 * today's date so this stays trivially testable.
 *
 * Durations are entered as DECIMAL HOURS in a single `number_input` per type
 * (`3.5`), not as separate hour and minute fields. Two inputs instead of
 * four; `parseLogTimeSubmission` converts to the `hours` + `minutes` ints
 * `createTimesheetBodySchema` wants, rounded to the nearest minute.
 */

export interface LogTimeProjectOption {
    id: string;
    label: string;
}

const plain = (text: string) => ({ type: 'plain_text' as const, text, emoji: true });

/**
 * Truncate a `static_select` option label to Slack's hard 75-char limit
 * (`SLACK_SELECT_OPTION_LABEL_MAX`). Applied here in the builder — the last
 * line of defence — the same place the option-COUNT cap
 * (`SLACK_SELECT_OPTION_CAP`) is already enforced, so a caller can't bypass
 * it by constructing options some other way. Only the display label is
 * truncated; the option `value` (the project id) is untouched, so submission
 * still resolves the real project.
 */
const truncateOptionLabel = (name: string): string =>
    name.length > SLACK_SELECT_OPTION_LABEL_MAX ? `${name.slice(0, SLACK_SELECT_OPTION_LABEL_MAX - 1)}…` : name;

/** A task offerable in the Ticket select. Same shape as a project option. */
export type LogTimeTicketOption = LogTimeProjectOption;

/**
 * Everything the user has already entered, read straight back off the view.
 *
 * `views.update` REPLACES a modal's blocks — Slack keeps none of the typed
 * values across one. Without re-seeding every field as `initial_*`, touching
 * the type select would wipe the date, durations and notes the user had
 * already filled in. Raw strings, deliberately: these go straight back into
 * `initial_value`, so parsing and re-formatting them would only introduce a
 * chance to change what the user typed.
 */
export interface LogTimeModalState {
    entry_type?: string;
    local_date?: string;
    project_id?: string;
    ticket_id?: string;
    context?: string;
    /** Selected duration in MINUTES, as the option value string. */
    billable?: string;
    non_billable?: string;
    description?: string;
}

export interface LogTimeModalOptions {
    state?: LogTimeModalState;
    /** The caller's open tickets in the SELECTED project. Empty when no
     *  project is chosen yet, or when the project has none for them. */
    tickets?: LogTimeTicketOption[];
}

/**
 * Preset durations for the billable / non-billable pickers.
 *
 * MIRRORS `components/duration-select.tsx` on the web deliberately: 15-min
 * steps under an hour, 30-min steps to 8h, then hourly to 24h (the per-field
 * cap, `TIMESHEET_HOURS_MAX`). If the two lists drift, the same field offers
 * different choices depending on where you log from.
 *
 * Values are plain MINUTES. The web stores "H:MM" strings because its grid
 * round-trips them as text; nothing here needs that, and minutes go straight
 * into the hours/minutes split the validator wants.
 */
const DURATION_STEP_MINUTES: number[] = [
    15,
    30,
    45,
    ...Array.from({ length: 15 }, (_, i) => 60 + i * 30),
    ...Array.from({ length: 16 }, (_, i) => (9 + i) * 60),
];

/** "45 min" / "1 hr" / "1.5 hr" — the web picker's labelling, unchanged. */
const durationLabel = (mins: number): string => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m} min`;
    return `${m === 30 ? `${h}.5` : h} hr`;
};

/** Leading "—" is a real option worth 0, not a placeholder: an `input` block
 *  is required, so "no time on this side" has to be selectable. */
const DURATION_OPTIONS: Array<{ text: { type: 'plain_text'; text: string; emoji: boolean }; value: string }> = [
    { text: plain('—'), value: '0' },
    ...DURATION_STEP_MINUTES.map((mins) => ({ text: plain(durationLabel(mins)), value: String(mins) })),
];

/** The option matching `minutes`, or the zero option. Slack REJECTS a view
 *  whose `initial_option` is absent from `options`, so an unrecognised value
 *  (a legacy "1:05", a hand-crafted payload) must fall back rather than be
 *  passed through. */
const durationInitial = (minutes: string | undefined) =>
    DURATION_OPTIONS.find((o) => o.value === minutes) ?? DURATION_OPTIONS[0]!;

/** A duration input block. */
const durationBlock = (blockId: string, label: string, selected: string | undefined) => ({
    type: 'input',
    block_id: blockId,
    label: plain(label),
    element: {
        type: 'static_select',
        action_id: blockId,
        options: DURATION_OPTIONS,
        initial_option: durationInitial(selected),
    },
});

const selectOption = (o: LogTimeProjectOption) => ({
    text: plain(truncateOptionLabel(o.label)),
    value: o.id,
});

/**
 * `initial_option` for a select, or nothing.
 *
 * Slack REJECTS the whole view when `initial_option` is not among `options`,
 * so a stale selection has to be dropped rather than passed through — which
 * is exactly what happens on a project change, where the previously chosen
 * ticket belongs to the project the user just navigated away from. Silently
 * dropping it is also the safe outcome: re-seeding it would let a submission
 * log time against another project's task.
 */
const initialOption = (options: LogTimeProjectOption[], selectedId: string | undefined) => {
    const hit = selectedId ? options.find((o) => o.id === selectedId) : undefined;
    return hit ? { initial_option: selectOption(hit) } : {};
};

export const buildLogTimeModal = (
    projects: LogTimeProjectOption[],
    todayIso: string,
    options: LogTimeModalOptions = {}
): Record<string, unknown> => {
    const state = options.state ?? {};
    const tickets = options.tickets ?? [];
    const isTicket = state.entry_type === SLACK_TS_TYPE_TICKET;
    const cappedProjects = projects.slice(0, SLACK_SELECT_OPTION_CAP);
    const cappedTickets = tickets.slice(0, SLACK_SELECT_OPTION_CAP);

    const blocks: Array<Record<string, unknown>> = [
        {
            type: 'input',
            block_id: SLACK_BLOCK_TS_DATE,
            label: plain('Date'),
            // Slack's datepicker has no `max_date`, so a future date is
            // refused server-side and surfaced as an inline error instead.
            element: {
                type: 'datepicker',
                action_id: SLACK_BLOCK_TS_DATE,
                initial_date: state.local_date ?? todayIso,
            },
        },
    ];

    if (projects.length === 0) {
        // A `static_select` with an empty `options` array is an API error, so
        // explain the situation rather than fail to open the modal at all.
        blocks.push({
            type: 'section',
            text: {
                type: 'mrkdwn',
                text: "You're not a member of any project yet — you can still log general time below. Ask an admin to add you to a project to log against one.",
            },
        });
    } else {
        blocks.push({
            type: 'input',
            block_id: SLACK_BLOCK_TS_PROJECT,
            // Changing the project has to re-load the ticket list, so this
            // block reports changes instead of staying silent until submit.
            dispatch_action: true,
            // A ticket always implies its project; general time need not have
            // one at all (a meeting, support, training), and then the Context
            // select below turns required instead.
            optional: !isTicket,
            label: plain('Project'),
            element: {
                type: 'static_select',
                action_id: SLACK_BLOCK_TS_PROJECT,
                placeholder: plain('Pick a project'),
                options: cappedProjects.map(selectOption),
                ...initialOption(cappedProjects, state.project_id),
            },
        });
    }

    // Type switch, then whichever field it selects.
    blocks.push({
        type: 'input',
        block_id: SLACK_BLOCK_TS_TYPE,
        dispatch_action: true,
        label: plain('Type'),
        element: {
            type: 'static_select',
            action_id: SLACK_BLOCK_TS_TYPE,
            options: [
                { text: plain('General'), value: SLACK_TS_TYPE_GENERAL },
                { text: plain('Ticket'), value: SLACK_TS_TYPE_TICKET },
            ],
            initial_option: isTicket
                ? { text: plain('Ticket'), value: SLACK_TS_TYPE_TICKET }
                : { text: plain('General'), value: SLACK_TS_TYPE_GENERAL },
        },
    });

    if (isTicket) {
        if (cappedTickets.length === 0) {
            // A `static_select` with an empty `options` array is an API
            // error, so both dead ends degrade to a section. The two are
            // worth distinguishing: one is a step the user has not taken
            // yet, the other is a fact about the project.
            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: state.project_id
                        ? 'No open tickets assigned to you on this project. Switch to *General*, or pick another project.'
                        : 'Choose a project first and your open tickets will appear here.',
                },
            });
        } else {
            blocks.push({
                type: 'input',
                block_id: SLACK_BLOCK_TS_TICKET,
                label: plain('Ticket'),
                element: {
                    type: 'static_select',
                    action_id: SLACK_BLOCK_TS_TICKET,
                    placeholder: plain('Pick a ticket'),
                    options: cappedTickets.map(selectOption),
                    ...initialOption(cappedTickets, state.ticket_id),
                },
            });
        }
    } else {
        // Two different fields behind one block id, chosen by whether a
        // project is carrying the attribution. WITH a project the value only
        // refines it, so free text naming the area worked on is fine; WITHOUT
        // one it IS the attribution, so it must come off a list that can be
        // grouped and charted. The project select already dispatches its
        // changes, so the swap rides the `views.update` that re-renders the
        // rest of the modal — no extra round-trip.
        const categoryOptions = TIMESHEET_GENERAL_CATEGORIES.map((c) => ({ text: plain(c), value: c }));
        const initialCategory = categoryOptions.find((o) => o.value === state.context);
        blocks.push(
            state.project_id
                ? {
                      type: 'input',
                      block_id: SLACK_BLOCK_TS_CONTEXT,
                      optional: true,
                      label: plain('Area worked on'),
                      element: {
                          type: 'plain_text_input',
                          action_id: SLACK_BLOCK_TS_CONTEXT,
                          max_length: TIMESHEET_GENERAL_CATEGORY_MAX,
                          placeholder: plain('Payroll module, Login flow, …'),
                          ...(state.context ? { initial_value: state.context } : {}),
                      },
                  }
                : {
                      type: 'input',
                      block_id: SLACK_BLOCK_TS_CONTEXT,
                      optional: false,
                      label: plain('What for?'),
                      element: {
                          type: 'static_select',
                          action_id: SLACK_BLOCK_TS_CONTEXT,
                          placeholder: plain('Meeting, Support, …'),
                          options: categoryOptions,
                          // Slack rejects an `initial_option` absent from
                          // `options`, so a free-text value carried over from
                          // the project path is dropped, not re-seeded.
                          ...(initialCategory ? { initial_option: initialCategory } : {}),
                      },
                  }
        );
    }

    blocks.push(
        durationBlock(SLACK_BLOCK_TS_BILLABLE, 'Billable', state.billable),
        durationBlock(SLACK_BLOCK_TS_NON_BILLABLE, 'Non-billable', state.non_billable),
        {
            type: 'input',
            block_id: SLACK_BLOCK_TS_DESCRIPTION,
            label: plain('What did you do?'),
            element: {
                type: 'plain_text_input',
                action_id: SLACK_BLOCK_TS_DESCRIPTION,
                multiline: true,
                placeholder: plain('Fixed the depot routing bug'),
                ...(state.description ? { initial_value: state.description } : {}),
            },
        }
    );

    return {
        type: 'modal',
        callback_id: SLACK_CALLBACK_LOG_TIME,
        title: plain('Log time'),
        submit: plain('Submit'),
        close: plain('Cancel'),
        blocks,
    };
};

// ─── Submission parsing ───────────────────────────────────────────────────

interface StateValue {
    value?: string;
    selected_date?: string;
    selected_option?: { value?: string } | null;
}
type StateValues = Record<string, Record<string, StateValue>>;

/** Block id and action id are the same string throughout this codebase. */
const cell = (values: StateValues, block: string): StateValue => values?.[block]?.[block] ?? {};

/**
 * Selected minutes → whole hours + minutes.
 *
 * The durations were a decimal-hours `number_input` ("3.5") and are now a
 * preset `static_select` carrying plain minutes, matching the web picker.
 * That removed a class of problem rather than moving it: no float rounding,
 * and no way to type 100 hours into a field the validator caps at 24 — the
 * option list simply stops there.
 */
const toHoursMinutes = (raw: string | undefined): { hours: number; minutes: number } => {
    const total = Number.parseInt(raw ?? '', 10);
    if (!Number.isFinite(total) || total < 0) return { hours: 0, minutes: 0 };
    return { hours: Math.floor(total / 60), minutes: total % 60 };
};

export interface ParsedLogTimeSubmission {
    local_date?: string;
    project_id?: string;
    /** Slack-facing type ('general' | 'ticket'). The submit handler maps it
     *  onto the persisted `entry_type`; this stays in Slack's vocabulary. */
    entry_type: string;
    task_id: string | null;
    general_category: string | null;
    billable_hours: number;
    billable_minutes: number;
    non_billable_hours: number;
    non_billable_minutes: number;
    description?: string;
}

/**
 * Read the raw, un-converted field values back off a view.
 *
 * Used on the `views.update` path, where the modal is re-rendered mid-edit
 * and every field has to be handed back to the builder as `initial_*`.
 * Distinct from `parseLogTimeSubmission`, which converts for the validator —
 * re-seeding wants exactly the characters the user typed, not a round-trip
 * through decimal-hours arithmetic.
 */
export const readLogTimeState = (view: unknown): LogTimeModalState => {
    const values = ((view as { state?: { values?: StateValues } })?.state?.values ?? {}) as StateValues;
    return {
        entry_type: cell(values, SLACK_BLOCK_TS_TYPE).selected_option?.value ?? SLACK_TS_TYPE_GENERAL,
        local_date: cell(values, SLACK_BLOCK_TS_DATE).selected_date ?? undefined,
        project_id: cell(values, SLACK_BLOCK_TS_PROJECT).selected_option?.value ?? undefined,
        ticket_id: cell(values, SLACK_BLOCK_TS_TICKET).selected_option?.value ?? undefined,
        // Either element type, depending on whether a project was chosen —
        // the re-seed has to survive the user switching between them.
        context:
            cell(values, SLACK_BLOCK_TS_CONTEXT).selected_option?.value ??
            cell(values, SLACK_BLOCK_TS_CONTEXT).value ??
            undefined,
        billable: cell(values, SLACK_BLOCK_TS_BILLABLE).selected_option?.value ?? undefined,
        non_billable: cell(values, SLACK_BLOCK_TS_NON_BILLABLE).selected_option?.value ?? undefined,
        description: cell(values, SLACK_BLOCK_TS_DESCRIPTION).value ?? undefined,
    };
};

export const parseLogTimeSubmission = (view: unknown): ParsedLogTimeSubmission => {
    const values = ((view as { state?: { values?: StateValues } })?.state?.values ?? {}) as StateValues;
    const billable = toHoursMinutes(cell(values, SLACK_BLOCK_TS_BILLABLE).selected_option?.value);
    const nonBillable = toHoursMinutes(cell(values, SLACK_BLOCK_TS_NON_BILLABLE).selected_option?.value);
    const entryType = cell(values, SLACK_BLOCK_TS_TYPE).selected_option?.value ?? SLACK_TS_TYPE_GENERAL;
    const isTicket = entryType === SLACK_TS_TYPE_TICKET;
    // Null, not '': an untouched optional field has no value, and the
    // validator's `general_category` is `.min(1)`, which '' would fail.
    const contextCell = cell(values, SLACK_BLOCK_TS_CONTEXT);
    const context = (contextCell.selected_option?.value ?? contextCell.value ?? '').trim();
    return {
        local_date: cell(values, SLACK_BLOCK_TS_DATE).selected_date ?? undefined,
        project_id: cell(values, SLACK_BLOCK_TS_PROJECT).selected_option?.value ?? undefined,
        entry_type: entryType,
        // Each branch nulls the other's field — the validator's discriminated
        // union refuses a task_id on a general entry and vice versa.
        task_id: isTicket ? (cell(values, SLACK_BLOCK_TS_TICKET).selected_option?.value ?? null) : null,
        general_category: isTicket ? null : context || null,
        billable_hours: billable.hours,
        billable_minutes: billable.minutes,
        non_billable_hours: nonBillable.hours,
        non_billable_minutes: nonBillable.minutes,
        description: cell(values, SLACK_BLOCK_TS_DESCRIPTION).value ?? undefined,
    };
};

// ─── Error mapping ────────────────────────────────────────────────────────

/** Block ids present in a submitted `view_submission` — `state.values` is
 *  only keyed by blocks Slack actually rendered, so this doubles as "what
 *  can an error safely target". */
const presentBlockIds = (view: unknown): Set<string> =>
    new Set(Object.keys(((view as { state?: { values?: StateValues } })?.state?.values ?? {}) as StateValues));

/**
 * Re-key any error whose target block is absent from the submitted view onto
 * `SLACK_BLOCK_TS_DESCRIPTION`, which `buildLogTimeModal` always renders.
 *
 * Slack silently DROPS an error keyed to a block that isn't in the view — the
 * project block is exactly this for a caller with no projects
 * (`buildLogTimeModal` substitutes explanatory text instead of the select).
 * Without this guard, that submission fails with no visible feedback at all:
 * the modal just sits there. Both error-producing paths (Zod validation
 * issues in the controller, and `timesheetAppErrorToModalErrors` below) route
 * through this one guard so neither — nor a future one — can reintroduce the
 * bug by mapping to a block that turns out to be conditional.
 */
export const guardModalErrors = (errors: Record<string, string>, view: unknown): Record<string, string> => {
    const present = presentBlockIds(view);
    const guarded: Record<string, string> = {};
    for (const [block, message] of Object.entries(errors)) {
        const target = present.has(block) ? block : SLACK_BLOCK_TS_DESCRIPTION;
        // First write wins — don't let a re-keyed error clobber a real
        // description-block error that was already there.
        if (!(target in guarded)) guarded[target] = message;
    }
    return guarded;
};

/**
 * Map a thrown `AppError.code` onto a `response_action: errors` payload,
 * guarded against targeting a block that isn't in the caller's view (see
 * `guardModalErrors`).
 */
export const timesheetAppErrorToModalErrors = (
    code: string | undefined,
    message: string,
    view: unknown
): Record<string, string> => {
    const errors = ((): Record<string, string> => {
        switch (code) {
            case ERROR_CODES.TIMESHEET_FUTURE_DATE:
                return { [SLACK_BLOCK_TS_DATE]: message };
            case ERROR_CODES.TIMESHEET_ZERO_DURATION:
            case ERROR_CODES.TIMESHEET_DURATION_TOO_LARGE:
                return { [SLACK_BLOCK_TS_BILLABLE]: message };
            case ERROR_CODES.PROJECT_NOT_FOUND:
            case ERROR_CODES.FORBIDDEN:
                return { [SLACK_BLOCK_TS_PROJECT]: message };
            default:
                return { [SLACK_BLOCK_TS_DESCRIPTION]: message };
        }
    })();
    return guardModalErrors(errors, view);
};
