import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../../constants/error-codes.js';
import {
    SLACK_BLOCK_TS_BILLABLE,
    SLACK_BLOCK_TS_DATE,
    SLACK_BLOCK_TS_DESCRIPTION,
    SLACK_BLOCK_TS_NON_BILLABLE,
    SLACK_BLOCK_TS_PROJECT,
    SLACK_CALLBACK_LOG_TIME,
} from '../../constants/slack.js';
import { buildLogTimeModal, parseLogTimeSubmission, timesheetAppErrorToModalErrors } from './timesheet.js';

const PROJECTS = [
    { id: '6a5dd789cb47f588a23516e7', label: 'Nordmark Fleet Dashboard' },
    { id: '6a5dd7a2cb47f588a2351721', label: 'Aurora Foods Supply Portal' },
];

/** A `view_submission` view, shaped the way Slack sends it: state.values is
 *  keyed block_id → action_id, and this codebase uses the same string for
 *  both (see `cell()` in slack-leave-blocks.ts). */
const viewWith = (over: Record<string, unknown> = {}) => ({
    state: {
        values: {
            [SLACK_BLOCK_TS_DATE]: { [SLACK_BLOCK_TS_DATE]: { selected_date: '2026-09-07' } },
            [SLACK_BLOCK_TS_PROJECT]: {
                [SLACK_BLOCK_TS_PROJECT]: { selected_option: { value: PROJECTS[0]!.id } },
            },
            [SLACK_BLOCK_TS_BILLABLE]: { [SLACK_BLOCK_TS_BILLABLE]: { value: '3.5' } },
            [SLACK_BLOCK_TS_NON_BILLABLE]: { [SLACK_BLOCK_TS_NON_BILLABLE]: { value: '0' } },
            [SLACK_BLOCK_TS_DESCRIPTION]: {
                [SLACK_BLOCK_TS_DESCRIPTION]: { value: 'Depot routing bug' },
            },
            ...over,
        },
    },
});

describe('buildLogTimeModal', () => {
    it('is a modal Slack will route back to us', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-07');
        expect(view.type).toBe('modal');
        expect(view.callback_id).toBe(SLACK_CALLBACK_LOG_TIME);
    });

    it('defaults the date picker to today', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-07');
        const blocks = view.blocks as Array<Record<string, any>>;
        const date = blocks.find((b) => b.block_id === SLACK_BLOCK_TS_DATE)!;
        expect(date.element.initial_date).toBe('2026-09-07');
    });

    it('lists every project as an option', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-07');
        const blocks = view.blocks as Array<Record<string, any>>;
        const project = blocks.find((b) => b.block_id === SLACK_BLOCK_TS_PROJECT)!;
        expect(project.element.options).toHaveLength(2);
        expect(project.element.options[0].value).toBe(PROJECTS[0]!.id);
        expect(project.element.options[0].text.text).toBe('Nordmark Fleet Dashboard');
    });

    it("caps the project list at Slack's 100-option ceiling", () => {
        const many = Array.from({ length: 150 }, (_, i) => ({ id: `p${i}`, label: `Project ${i}` }));
        const view = buildLogTimeModal(many, '2026-09-07');
        const blocks = view.blocks as Array<Record<string, any>>;
        const project = blocks.find((b) => b.block_id === SLACK_BLOCK_TS_PROJECT)!;
        // 101 options is a Slack API error, not a truncated menu.
        expect(project.element.options).toHaveLength(100);
    });

    it('renders no project select when the caller has no projects', () => {
        const view = buildLogTimeModal([], '2026-09-07');
        const blocks = view.blocks as Array<Record<string, any>>;
        expect(blocks.find((b) => b.block_id === SLACK_BLOCK_TS_PROJECT)).toBeUndefined();
        // A static_select with an empty options array is rejected by Slack,
        // so the modal explains itself instead of failing to open.
        expect(JSON.stringify(blocks)).toContain('not a member of any project');
    });

    it('marks the description required and multiline', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-07');
        const blocks = view.blocks as Array<Record<string, any>>;
        const desc = blocks.find((b) => b.block_id === SLACK_BLOCK_TS_DESCRIPTION)!;
        expect(desc.optional).toBeFalsy();
        expect(desc.element.multiline).toBe(true);
    });
});

describe('parseLogTimeSubmission', () => {
    it('reads every field and converts decimal hours to hours + minutes', () => {
        expect(parseLogTimeSubmission(viewWith())).toEqual({
            local_date: '2026-09-07',
            project_id: PROJECTS[0]!.id,
            billable_hours: 3,
            billable_minutes: 30,
            non_billable_hours: 0,
            non_billable_minutes: 0,
            description: 'Depot routing bug',
        });
    });

    it('rounds to the nearest minute', () => {
        const parsed = parseLogTimeSubmission(
            viewWith({
                [SLACK_BLOCK_TS_BILLABLE]: { [SLACK_BLOCK_TS_BILLABLE]: { value: '3.33' } },
            })
        );
        // 3.33h = 199.8 minutes -> 200 -> 3h 20m
        expect(parsed.billable_hours).toBe(3);
        expect(parsed.billable_minutes).toBe(20);
    });

    it('treats a blank or absent duration as zero rather than NaN', () => {
        const parsed = parseLogTimeSubmission(
            viewWith({
                [SLACK_BLOCK_TS_BILLABLE]: { [SLACK_BLOCK_TS_BILLABLE]: { value: '' } },
                [SLACK_BLOCK_TS_NON_BILLABLE]: { [SLACK_BLOCK_TS_NON_BILLABLE]: {} },
            })
        );
        expect(parsed.billable_hours).toBe(0);
        expect(parsed.billable_minutes).toBe(0);
        expect(parsed.non_billable_hours).toBe(0);
        expect(parsed.non_billable_minutes).toBe(0);
    });

    it('survives a malformed payload without throwing', () => {
        const parsed = parseLogTimeSubmission({});
        expect(parsed.local_date).toBeUndefined();
        expect(parsed.project_id).toBeUndefined();
        expect(parsed.billable_hours).toBe(0);
    });
});

describe('timesheetAppErrorToModalErrors', () => {
    it('puts a future-date refusal on the date block', () => {
        const errors = timesheetAppErrorToModalErrors(ERROR_CODES.TIMESHEET_FUTURE_DATE, 'nope');
        expect(Object.keys(errors)).toEqual([SLACK_BLOCK_TS_DATE]);
    });

    it('puts a zero duration on the billable block', () => {
        const errors = timesheetAppErrorToModalErrors(ERROR_CODES.TIMESHEET_ZERO_DURATION, 'nope');
        expect(Object.keys(errors)).toEqual([SLACK_BLOCK_TS_BILLABLE]);
    });

    it('puts an over-long duration on the billable block', () => {
        const errors = timesheetAppErrorToModalErrors(ERROR_CODES.TIMESHEET_DURATION_TOO_LARGE, 'nope');
        expect(Object.keys(errors)).toEqual([SLACK_BLOCK_TS_BILLABLE]);
    });

    it('puts an unreachable project on the project block', () => {
        const errors = timesheetAppErrorToModalErrors(ERROR_CODES.PROJECT_NOT_FOUND, 'nope');
        expect(Object.keys(errors)).toEqual([SLACK_BLOCK_TS_PROJECT]);
    });

    it('falls back to the always-present description block for unmapped codes', () => {
        // Slack drops errors keyed to a block that isn't in the view, so an
        // unmapped code must land somewhere that always exists or the user
        // sees a silent no-op.
        const errors = timesheetAppErrorToModalErrors('SOMETHING_NEW', 'Sorry, that failed.');
        expect(errors[SLACK_BLOCK_TS_DESCRIPTION]).toBe('Sorry, that failed.');
    });
});
