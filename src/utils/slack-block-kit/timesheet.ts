import { ERROR_CODES } from '../../constants/error-codes.js';
import {
    SLACK_BLOCK_TS_BILLABLE,
    SLACK_BLOCK_TS_DATE,
    SLACK_BLOCK_TS_DESCRIPTION,
    SLACK_BLOCK_TS_NON_BILLABLE,
    SLACK_BLOCK_TS_PROJECT,
    SLACK_CALLBACK_LOG_TIME,
    SLACK_SELECT_OPTION_CAP,
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

export const buildLogTimeModal = (projects: LogTimeProjectOption[], todayIso: string): Record<string, unknown> => {
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
                initial_date: todayIso,
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
                text: "You're not a member of any project yet, so there's nothing to log time against. Ask an admin to add you to one.",
            },
        });
    } else {
        blocks.push({
            type: 'input',
            block_id: SLACK_BLOCK_TS_PROJECT,
            label: plain('Project'),
            element: {
                type: 'static_select',
                action_id: SLACK_BLOCK_TS_PROJECT,
                placeholder: plain('Pick a project'),
                options: projects.slice(0, SLACK_SELECT_OPTION_CAP).map((p) => ({
                    text: plain(p.label),
                    value: p.id,
                })),
            },
        });
    }

    blocks.push(
        {
            type: 'input',
            block_id: SLACK_BLOCK_TS_BILLABLE,
            label: plain('Billable hours'),
            element: {
                type: 'number_input',
                action_id: SLACK_BLOCK_TS_BILLABLE,
                is_decimal_allowed: true,
                min_value: '0',
                initial_value: '0',
            },
        },
        {
            type: 'input',
            block_id: SLACK_BLOCK_TS_NON_BILLABLE,
            label: plain('Non-billable hours'),
            element: {
                type: 'number_input',
                action_id: SLACK_BLOCK_TS_NON_BILLABLE,
                is_decimal_allowed: true,
                min_value: '0',
                initial_value: '0',
            },
        },
        {
            type: 'input',
            block_id: SLACK_BLOCK_TS_DESCRIPTION,
            label: plain('What did you do?'),
            element: {
                type: 'plain_text_input',
                action_id: SLACK_BLOCK_TS_DESCRIPTION,
                multiline: true,
                placeholder: plain('Fixed the depot routing bug'),
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

/** Decimal hours → whole hours + minutes, rounded to the nearest minute. */
const toHoursMinutes = (raw: string | undefined): { hours: number; minutes: number } => {
    const parsed = Number.parseFloat(raw ?? '');
    if (!Number.isFinite(parsed) || parsed < 0) return { hours: 0, minutes: 0 };
    const totalMinutes = Math.round(parsed * 60);
    return { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
};

export interface ParsedLogTimeSubmission {
    local_date?: string;
    project_id?: string;
    billable_hours: number;
    billable_minutes: number;
    non_billable_hours: number;
    non_billable_minutes: number;
    description?: string;
}

export const parseLogTimeSubmission = (view: unknown): ParsedLogTimeSubmission => {
    const values = ((view as { state?: { values?: StateValues } })?.state?.values ?? {}) as StateValues;
    const billable = toHoursMinutes(cell(values, SLACK_BLOCK_TS_BILLABLE).value);
    const nonBillable = toHoursMinutes(cell(values, SLACK_BLOCK_TS_NON_BILLABLE).value);
    return {
        local_date: cell(values, SLACK_BLOCK_TS_DATE).selected_date ?? undefined,
        project_id: cell(values, SLACK_BLOCK_TS_PROJECT).selected_option?.value ?? undefined,
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
