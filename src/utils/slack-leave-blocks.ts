import { ERROR_CODES } from '../constants/error-codes.js';
import { HALF_DAY_SLOTS } from '../constants/leave.js';
import {
    SLACK_BLOCK_END_DATE,
    SLACK_BLOCK_HALF_DAY,
    SLACK_BLOCK_LEAVE_TYPE,
    SLACK_BLOCK_REASON,
    SLACK_BLOCK_START_DATE,
    SLACK_CALLBACK_APPLY_LEAVE,
} from '../constants/slack.js';

/**
 * Pure Block Kit for the Apply-for-leave modal: build the view, parse the
 * `view_submission` state back into an `applyLeaveBodySchema`-shaped object,
 * and map a thrown `AppError.code` to inline field errors. No I/O — unit
 * testable without Slack or HTTP.
 */

export interface ApplyLeaveModalType {
    id: string;
    code: string;
    name: string;
    /** Current-year available balance, or null for types with no balance row
     *  (unlimited / earned). Null types render with no "— N left" suffix. */
    available: number | null;
}

const plain = (text: string) => ({ type: 'plain_text' as const, text });

/** "Casual Leave — 8 left" when a balance exists, else just the name. */
const typeLabel = (t: ApplyLeaveModalType): string =>
    t.available === null ? t.name : `${t.name} — ${t.available} left`;

/**
 * Build the modal `view`. `today` (YYYY-MM-DD, IST) seeds the date pickers so
 * the common same-day request needs no taps. `types` must be non-empty — the
 * caller checks and shows an ephemeral when there are none.
 */
export const buildApplyLeaveModal = (types: ApplyLeaveModalType[], today: string): Record<string, unknown> => ({
    type: 'modal',
    callback_id: SLACK_CALLBACK_APPLY_LEAVE,
    title: plain('Apply for leave'),
    submit: plain('Submit'),
    close: plain('Cancel'),
    blocks: [
        {
            type: 'input',
            block_id: SLACK_BLOCK_LEAVE_TYPE,
            label: plain('Leave type'),
            element: {
                type: 'static_select',
                action_id: SLACK_BLOCK_LEAVE_TYPE,
                placeholder: plain('Pick a leave type'),
                options: types.map((t) => ({ text: plain(typeLabel(t)), value: t.id })),
            },
        },
        {
            type: 'input',
            block_id: SLACK_BLOCK_START_DATE,
            label: plain('Start date'),
            element: { type: 'datepicker', action_id: SLACK_BLOCK_START_DATE, initial_date: today },
        },
        {
            type: 'input',
            block_id: SLACK_BLOCK_END_DATE,
            label: plain('End date'),
            element: { type: 'datepicker', action_id: SLACK_BLOCK_END_DATE, initial_date: today },
        },
        {
            type: 'input',
            block_id: SLACK_BLOCK_HALF_DAY,
            optional: true,
            label: plain('Half day'),
            element: {
                type: 'static_select',
                action_id: SLACK_BLOCK_HALF_DAY,
                placeholder: plain('Full day'),
                options: [
                    { text: plain('Full day'), value: 'none' },
                    { text: plain('First half'), value: HALF_DAY_SLOTS.FIRST_HALF },
                    { text: plain('Second half'), value: HALF_DAY_SLOTS.SECOND_HALF },
                ],
            },
        },
        {
            type: 'input',
            block_id: SLACK_BLOCK_REASON,
            label: plain('Reason'),
            element: { type: 'plain_text_input', action_id: SLACK_BLOCK_REASON, multiline: true },
        },
    ],
});

export interface ParsedLeaveSubmission {
    leave_type_id?: string;
    start_date?: string;
    end_date?: string;
    is_half_day: boolean;
    half_day_slot: 'first_half' | 'second_half' | null;
    reason?: string;
}

interface StateValue {
    selected_option?: { value?: string } | null;
    selected_date?: string | null;
    value?: string | null;
}
type StateValues = Record<string, Record<string, StateValue>>;

/** Pull one input's value out of the nested `state.values[block][action]` shape. */
const cell = (values: StateValues, block: string): StateValue => values?.[block]?.[block] ?? {};

/**
 * Map a `view_submission` payload to an `applyLeaveBodySchema`-shaped object.
 * The half-day select translates: 'none'/absent → full day; 'first_half'/
 * 'second_half' → is_half_day + slot. Required inputs (type, dates, reason)
 * are enforced by Slack itself (non-optional `input` blocks), so missing
 * values here would only occur on a malformed payload — left `undefined` for
 * the schema to reject.
 */
export const parseApplyLeaveSubmission = (view: unknown): ParsedLeaveSubmission => {
    const values = ((view as { state?: { values?: StateValues } })?.state?.values ?? {}) as StateValues;
    const halfVal = cell(values, SLACK_BLOCK_HALF_DAY).selected_option?.value;
    const isHalf = halfVal === HALF_DAY_SLOTS.FIRST_HALF || halfVal === HALF_DAY_SLOTS.SECOND_HALF;
    return {
        leave_type_id: cell(values, SLACK_BLOCK_LEAVE_TYPE).selected_option?.value ?? undefined,
        start_date: cell(values, SLACK_BLOCK_START_DATE).selected_date ?? undefined,
        end_date: cell(values, SLACK_BLOCK_END_DATE).selected_date ?? undefined,
        is_half_day: isHalf,
        half_day_slot: isHalf ? (halfVal as 'first_half' | 'second_half') : null,
        reason: cell(values, SLACK_BLOCK_REASON).value ?? undefined,
    };
};

/**
 * Map a thrown `AppError.code` to a `response_action: errors` payload keyed by
 * block_id. Slack only renders errors attached to an existing input block, so
 * unmapped codes fall back to the always-present `reason` block rather than a
 * (Slack-unsupported) top-level error.
 */
export const appErrorToModalErrors = (code: string | undefined, message: string): Record<string, string> => {
    // Note: end_date errors (start>end, span overflow) are caught at the Zod layer and mapped to the
    // end_date block by the controller — they never reach this AppError map, so there is no end_date case here.
    switch (code) {
        case ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE:
        case ERROR_CODES.RESOURCE_NOT_FOUND:
            return { [SLACK_BLOCK_LEAVE_TYPE]: message };
        case ERROR_CODES.LEAVE_BACKDATED_NOT_ALLOWED:
        case ERROR_CODES.LEAVE_NOTICE_VIOLATION:
        case ERROR_CODES.LEAVE_OVERLAP:
        case ERROR_CODES.LEAVE_NO_WORKING_DAYS:
            return { [SLACK_BLOCK_START_DATE]: message };
        case ERROR_CODES.LEAVE_INVALID_HALF_DAY:
            return { [SLACK_BLOCK_HALF_DAY]: message };
        default:
            return { [SLACK_BLOCK_REASON]: message };
    }
};
