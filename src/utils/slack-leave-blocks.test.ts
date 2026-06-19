import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../constants/error-codes.js';
import {
    SLACK_BLOCK_END_DATE,
    SLACK_BLOCK_HALF_DAY,
    SLACK_BLOCK_LEAVE_TYPE,
    SLACK_BLOCK_REASON,
    SLACK_BLOCK_START_DATE,
    SLACK_CALLBACK_APPLY_LEAVE,
} from '../constants/slack.js';
import { appErrorToModalErrors, buildApplyLeaveModal, parseApplyLeaveSubmission } from './slack-leave-blocks.js';

const types = [
    { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', code: 'CL', name: 'Casual Leave', available: 8 },
    { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', code: 'WFH', name: 'Work From Home', available: null },
];

describe('buildApplyLeaveModal', () => {
    const view = buildApplyLeaveModal(types, '2026-06-19') as {
        type: string;
        callback_id: string;
        blocks: Array<{ block_id?: string; optional?: boolean; element?: { type?: string; options?: Array<{ text: { text: string }; value: string }>; initial_date?: string } }>;
    };

    it('is a modal with the apply callback_id and five input blocks in order', () => {
        expect(view.type).toBe('modal');
        expect(view.callback_id).toBe(SLACK_CALLBACK_APPLY_LEAVE);
        const ids = view.blocks.map((b) => b.block_id);
        expect(ids).toEqual([
            SLACK_BLOCK_LEAVE_TYPE,
            SLACK_BLOCK_START_DATE,
            SLACK_BLOCK_END_DATE,
            SLACK_BLOCK_HALF_DAY,
            SLACK_BLOCK_REASON,
        ]);
    });

    it('labels leave-type options with balance when present, name only when null', () => {
        const opts = view.blocks[0]!.element!.options!;
        expect(opts[0]).toEqual({ text: { type: 'plain_text', text: 'Casual Leave — 8 left' }, value: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
        expect(opts[1]!.text.text).toBe('Work From Home');
    });

    it('marks only the half-day block optional and seeds date pickers with today', () => {
        const halfBlock = view.blocks.find((b) => b.block_id === SLACK_BLOCK_HALF_DAY)!;
        expect(halfBlock.optional).toBe(true);
        expect(view.blocks[1]!.element!.initial_date).toBe('2026-06-19');
        expect(view.blocks[2]!.element!.initial_date).toBe('2026-06-19');
    });
});

describe('parseApplyLeaveSubmission', () => {
    const makeView = (half?: string) => ({
        state: {
            values: {
                [SLACK_BLOCK_LEAVE_TYPE]: { [SLACK_BLOCK_LEAVE_TYPE]: { selected_option: { value: 'aaaaaaaaaaaaaaaaaaaaaaaa' } } },
                [SLACK_BLOCK_START_DATE]: { [SLACK_BLOCK_START_DATE]: { selected_date: '2026-06-25' } },
                [SLACK_BLOCK_END_DATE]: { [SLACK_BLOCK_END_DATE]: { selected_date: '2026-06-26' } },
                [SLACK_BLOCK_HALF_DAY]: { [SLACK_BLOCK_HALF_DAY]: half ? { selected_option: { value: half } } : {} },
                [SLACK_BLOCK_REASON]: { [SLACK_BLOCK_REASON]: { value: 'Family event' } },
            },
        },
    });

    it('maps values and treats "none"/absent half-day as a full-day request', () => {
        expect(parseApplyLeaveSubmission(makeView('none'))).toEqual({
            leave_type_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
            start_date: '2026-06-25',
            end_date: '2026-06-26',
            is_half_day: false,
            half_day_slot: null,
            reason: 'Family event',
        });
        expect(parseApplyLeaveSubmission(makeView()).is_half_day).toBe(false);
    });

    it('translates a half-day slot into is_half_day + slot', () => {
        const parsed = parseApplyLeaveSubmission(makeView('first_half'));
        expect(parsed.is_half_day).toBe(true);
        expect(parsed.half_day_slot).toBe('first_half');
    });
});

describe('appErrorToModalErrors', () => {
    it('routes balance + type errors to the leave_type block', () => {
        expect(appErrorToModalErrors(ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE, 'no balance')).toEqual({
            [SLACK_BLOCK_LEAVE_TYPE]: 'no balance',
        });
        expect(Object.keys(appErrorToModalErrors(ERROR_CODES.RESOURCE_NOT_FOUND, 'x'))).toEqual([SLACK_BLOCK_LEAVE_TYPE]);
    });

    it('routes date-policy + overlap errors to start_date', () => {
        for (const code of [
            ERROR_CODES.LEAVE_BACKDATED_NOT_ALLOWED,
            ERROR_CODES.LEAVE_NOTICE_VIOLATION,
            ERROR_CODES.LEAVE_OVERLAP,
            ERROR_CODES.LEAVE_NO_WORKING_DAYS,
        ]) {
            expect(Object.keys(appErrorToModalErrors(code, 'm'))).toEqual([SLACK_BLOCK_START_DATE]);
        }
    });

    it('routes half-day errors to the half_day block', () => {
        expect(Object.keys(appErrorToModalErrors(ERROR_CODES.LEAVE_INVALID_HALF_DAY, 'm'))).toEqual([SLACK_BLOCK_HALF_DAY]);
    });

    it('falls back to the reason block for unmapped codes (Slack needs a real block_id)', () => {
        expect(Object.keys(appErrorToModalErrors('SOMETHING_ELSE', 'm'))).toEqual([SLACK_BLOCK_REASON]);
    });
});
