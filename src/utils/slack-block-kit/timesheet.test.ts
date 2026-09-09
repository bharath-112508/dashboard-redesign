import { describe, expect, it } from 'vitest';

import { ERROR_CODES } from '../../constants/error-codes.js';
import {
    SLACK_BLOCK_TS_BILLABLE,
    SLACK_BLOCK_TS_DATE,
    SLACK_BLOCK_TS_DESCRIPTION,
    SLACK_BLOCK_TS_NON_BILLABLE,
    SLACK_BLOCK_TS_PROJECT,
    SLACK_BLOCK_TS_CONTEXT,
    SLACK_BLOCK_TS_TICKET,
    SLACK_BLOCK_TS_TYPE,
    SLACK_CALLBACK_LOG_TIME,
    SLACK_TS_TYPE_GENERAL,
    SLACK_TS_TYPE_TICKET,
} from '../../constants/slack.js';
import {
    buildLogTimeModal,
    guardModalErrors,
    parseLogTimeSubmission,
    readLogTimeState,
    timesheetAppErrorToModalErrors,
} from './timesheet.js';

/** Just enough of a Block Kit block for these assertions — `any` would work
 *  but loses every typo check on the fields actually being read. */
/**
 * Block Kit blocks are loosely-typed JSON from Slack's schema, not ours, and
 * these assertions read several levels down (`element.initial_option.value`).
 * `any` is deliberate here and confined to this alias: the assertions are
 * what pin the structure, and a stricter shape only moved the noise into a
 * cast on every line.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BlockLike = Record<string, any>;

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
            // 210 minutes = the 3h 30m preset. Durations are a static_select
            // of preset minutes now, not a decimal-hours text box.
            [SLACK_BLOCK_TS_BILLABLE]: {
                [SLACK_BLOCK_TS_BILLABLE]: { selected_option: { value: '210' } },
            },
            [SLACK_BLOCK_TS_NON_BILLABLE]: {
                [SLACK_BLOCK_TS_NON_BILLABLE]: { selected_option: { value: '0' } },
            },
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
        const blocks = view.blocks as BlockLike[];
        const date = blocks.find((b) => b.block_id === SLACK_BLOCK_TS_DATE)!;
        expect(date.element.initial_date).toBe('2026-09-07');
    });

    it('lists every project as an option', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-07');
        const blocks = view.blocks as BlockLike[];
        const project = blocks.find((b) => b.block_id === SLACK_BLOCK_TS_PROJECT)!;
        expect(project.element.options).toHaveLength(2);
        expect(project.element.options[0].value).toBe(PROJECTS[0]!.id);
        expect(project.element.options[0].text.text).toBe('Nordmark Fleet Dashboard');
    });

    it("caps the project list at Slack's 100-option ceiling", () => {
        const many = Array.from({ length: 150 }, (_, i) => ({ id: `p${i}`, label: `Project ${i}` }));
        const view = buildLogTimeModal(many, '2026-09-07');
        const blocks = view.blocks as BlockLike[];
        const project = blocks.find((b) => b.block_id === SLACK_BLOCK_TS_PROJECT)!;
        // 101 options is a Slack API error, not a truncated menu.
        expect(project.element.options).toHaveLength(100);
    });

    it("truncates an option label over Slack's 75-char text limit, leaving the value (project id) untouched", () => {
        // 81 chars — Slack rejects the ENTIRE view with invalid_blocks if any
        // option's plain_text exceeds 75 chars, not just clips the label.
        const longName = 'Nordmark Fleet Telematics — Depot Routing & Driver Compliance Programme, Phase 2';
        expect(longName.length).toBeGreaterThan(75);
        const projects = [{ id: 'proj-1', label: longName }];
        const view = buildLogTimeModal(projects, '2026-09-07');
        const blocks = view.blocks as BlockLike[];
        const project = blocks.find((b) => b.block_id === SLACK_BLOCK_TS_PROJECT)!;
        const option = project.element.options[0];
        expect(option.text.text.length).toBeLessThanOrEqual(75);
        expect(option.text.text.endsWith('…')).toBe(true);
        // The id used to look up the project on submit must be untouched.
        expect(option.value).toBe('proj-1');
    });

    it('leaves an option label at or under the limit unchanged', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-07');
        const blocks = view.blocks as BlockLike[];
        const project = blocks.find((b) => b.block_id === SLACK_BLOCK_TS_PROJECT)!;
        expect(project.element.options[0].text.text).toBe('Nordmark Fleet Dashboard');
    });

    it('renders no project select when the caller has no projects', () => {
        const view = buildLogTimeModal([], '2026-09-07');
        const blocks = view.blocks as BlockLike[];
        expect(blocks.find((b) => b.block_id === SLACK_BLOCK_TS_PROJECT)).toBeUndefined();
        // A static_select with an empty options array is rejected by Slack,
        // so the modal explains itself instead of failing to open.
        expect(JSON.stringify(blocks)).toContain('not a member of any project');
    });

    it('marks the description required and multiline', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-07');
        const blocks = view.blocks as BlockLike[];
        const desc = blocks.find((b) => b.block_id === SLACK_BLOCK_TS_DESCRIPTION)!;
        expect(desc.optional).toBeFalsy();
        expect(desc.element.multiline).toBe(true);
    });
});

describe('parseLogTimeSubmission', () => {
    it('reads every field and converts the selected minutes to hours + minutes', () => {
        expect(parseLogTimeSubmission(viewWith())).toEqual({
            local_date: '2026-09-07',
            project_id: PROJECTS[0]!.id,
            // A view with no type block is a General entry — the default the
            // modal opens on, and the shape every pre-ticket view had.
            entry_type: SLACK_TS_TYPE_GENERAL,
            task_id: null,
            general_category: null,
            billable_hours: 3,
            billable_minutes: 30,
            non_billable_hours: 0,
            non_billable_minutes: 0,
            description: 'Depot routing bug',
        });
    });

    it('an unrecognised duration reads as zero rather than NaN', () => {
        // The old decimal input could be rounded; a select can only ever
        // return one of its own option values, so the remaining risk is a
        // hand-crafted payload — which must degrade to 0, not NaN.
        const parsed = parseLogTimeSubmission(
            viewWith({
                [SLACK_BLOCK_TS_BILLABLE]: {
                    [SLACK_BLOCK_TS_BILLABLE]: { selected_option: { value: 'not-a-number' } },
                },
            })
        );
        expect(parsed.billable_hours).toBe(0);
        expect(parsed.billable_minutes).toBe(0);
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

/** Same shape as `viewWith`, but omits the project block entirely — the
 *  shape `buildLogTimeModal` produces for a caller with no projects. */
const projectLessView = (over: Record<string, unknown> = {}) => {
    const view = viewWith(over);
    delete (view.state.values as Record<string, unknown>)[SLACK_BLOCK_TS_PROJECT];
    return view;
};

describe('timesheetAppErrorToModalErrors', () => {
    it('puts a future-date refusal on the date block', () => {
        const errors = timesheetAppErrorToModalErrors(ERROR_CODES.TIMESHEET_FUTURE_DATE, 'nope', viewWith());
        expect(Object.keys(errors)).toEqual([SLACK_BLOCK_TS_DATE]);
    });

    it('puts a zero duration on the billable block', () => {
        const errors = timesheetAppErrorToModalErrors(ERROR_CODES.TIMESHEET_ZERO_DURATION, 'nope', viewWith());
        expect(Object.keys(errors)).toEqual([SLACK_BLOCK_TS_BILLABLE]);
    });

    it('puts an over-long duration on the billable block', () => {
        const errors = timesheetAppErrorToModalErrors(ERROR_CODES.TIMESHEET_DURATION_TOO_LARGE, 'nope', viewWith());
        expect(Object.keys(errors)).toEqual([SLACK_BLOCK_TS_BILLABLE]);
    });

    it('puts an unreachable project on the project block', () => {
        const errors = timesheetAppErrorToModalErrors(ERROR_CODES.PROJECT_NOT_FOUND, 'nope', viewWith());
        expect(Object.keys(errors)).toEqual([SLACK_BLOCK_TS_PROJECT]);
    });

    it('falls back to the always-present description block for unmapped codes', () => {
        // Slack drops errors keyed to a block that isn't in the view, so an
        // unmapped code must land somewhere that always exists or the user
        // sees a silent no-op.
        const errors = timesheetAppErrorToModalErrors('SOMETHING_NEW', 'Sorry, that failed.', viewWith());
        expect(errors[SLACK_BLOCK_TS_DESCRIPTION]).toBe('Sorry, that failed.');
    });

    it('re-keys PROJECT_NOT_FOUND onto the description block for a project-less caller', () => {
        // buildLogTimeModal renders no project block when the caller has no
        // projects, so an error keyed to it would be silently dropped by
        // Slack — the exact failure this guard exists to close.
        const errors = timesheetAppErrorToModalErrors(
            ERROR_CODES.PROJECT_NOT_FOUND,
            'Project not found.',
            projectLessView()
        );
        expect(errors).toEqual({ [SLACK_BLOCK_TS_DESCRIPTION]: 'Project not found.' });
    });
});

describe('guardModalErrors', () => {
    it('leaves an error targeting a present block untouched', () => {
        const errors = guardModalErrors({ [SLACK_BLOCK_TS_DATE]: 'bad date' }, viewWith());
        expect(errors).toEqual({ [SLACK_BLOCK_TS_DATE]: 'bad date' });
    });

    it('re-keys an error targeting an absent block onto description', () => {
        const errors = guardModalErrors({ [SLACK_BLOCK_TS_PROJECT]: 'pick one' }, projectLessView());
        expect(errors).toEqual({ [SLACK_BLOCK_TS_DESCRIPTION]: 'pick one' });
    });

    it('does not let a re-keyed error clobber a real description error', () => {
        const errors = guardModalErrors(
            {
                [SLACK_BLOCK_TS_DESCRIPTION]: 'add a note',
                [SLACK_BLOCK_TS_PROJECT]: 'pick one',
            },
            projectLessView()
        );
        // First write wins — the real description error survives.
        expect(errors).toEqual({ [SLACK_BLOCK_TS_DESCRIPTION]: 'add a note' });
    });
});

// ─── Entry type: General vs Ticket ────────────────────────────────────────
//
// The modal opens on General (identical to the pre-ticket modal) and swaps
// the Ticket select in when the type changes. Both swaps go through
// `views.update`, which REPLACES the blocks — so anything already typed is
// re-seeded as `initial_*` here or it silently vanishes mid-form.

const blockIds = (view: Record<string, unknown>): string[] =>
    (view.blocks as Array<{ block_id?: string }>).map((b) => b.block_id ?? '').filter(Boolean);

const blockById = (view: Record<string, unknown>, id: string): Record<string, unknown> | undefined =>
    (view.blocks as BlockLike[]).find((b) => b.block_id === id);

const TICKETS = [
    { id: '6a9ff1a60f7ba40f3388d705', label: 'VJ-142 Fix login redirect loop' },
    { id: '6a9eca4944def63d1e821d77', label: 'VJ-160 Slack log-time modal' },
];

describe('buildLogTimeModal — entry type', () => {
    it('defaults to General: type select present, context shown, no ticket block', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09');
        const ids = blockIds(view);
        expect(ids).toContain(SLACK_BLOCK_TS_TYPE);
        expect(ids).toContain(SLACK_BLOCK_TS_CONTEXT);
        expect(ids).not.toContain(SLACK_BLOCK_TS_TICKET);
    });

    it('the type select dispatches, or changing it would never reach the server', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09');
        expect(blockById(view, SLACK_BLOCK_TS_TYPE)?.dispatch_action).toBe(true);
    });

    it('the project select dispatches too, so tickets can repopulate on change', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09');
        expect(blockById(view, SLACK_BLOCK_TS_PROJECT)?.dispatch_action).toBe(true);
    });

    it('Ticket type shows the ticket select and drops the context field', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09', {
            state: { entry_type: SLACK_TS_TYPE_TICKET },
            tickets: TICKETS,
        });
        const ids = blockIds(view);
        expect(ids).toContain(SLACK_BLOCK_TS_TICKET);
        expect(ids).not.toContain(SLACK_BLOCK_TS_CONTEXT);
    });

    it('context is optional — a general entry without one is valid', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09');
        expect(blockById(view, SLACK_BLOCK_TS_CONTEXT)?.optional).toBe(true);
    });
});

describe('buildLogTimeModal — ticket list edge cases', () => {
    it('no project chosen yet: says so instead of rendering an empty select', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09', {
            state: { entry_type: SLACK_TS_TYPE_TICKET },
            tickets: [],
        });
        // A static_select with zero options is a Slack API error, not an
        // empty menu — the modal must degrade to a section instead.
        expect(blockById(view, SLACK_BLOCK_TS_TICKET)).toBeUndefined();
        // Must be the guidance section, NOT the project select's own
        // "Pick a project" placeholder — an earlier version of this
        // assertion matched that and passed without the feature existing.
        expect(JSON.stringify(view)).toMatch(/choose a project first/i);
    });

    it('project chosen but no open tickets: explains rather than failing to render', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09', {
            state: { entry_type: SLACK_TS_TYPE_TICKET, project_id: PROJECTS[0].id },
            tickets: [],
        });
        expect(blockById(view, SLACK_BLOCK_TS_TICKET)).toBeUndefined();
        expect(JSON.stringify(view)).toMatch(/no open tickets/i);
    });

    it('caps the ticket list at Slack option ceiling', () => {
        const many = Array.from({ length: 150 }, (_, i) => ({ id: String(i).padStart(24, '0'), label: `T-${i}` }));
        const view = buildLogTimeModal(PROJECTS, '2026-09-09', {
            state: { entry_type: SLACK_TS_TYPE_TICKET, project_id: PROJECTS[0].id },
            tickets: many,
        });
        const el = blockById(view, SLACK_BLOCK_TS_TICKET)?.element as { options: unknown[] };
        expect(el.options).toHaveLength(100);
    });
});

describe('buildLogTimeModal — re-seeding on views.update', () => {
    // views.update replaces the blocks wholesale. Without initial_* the user
    // loses everything they typed the moment they touch the type select.
    const state = {
        entry_type: SLACK_TS_TYPE_TICKET,
        local_date: '2026-09-01',
        project_id: PROJECTS[1].id,
        ticket_id: TICKETS[0].id,
        billable: '150',
        non_billable: '30',
        description: 'Paired on the routing bug',
    };

    it('keeps the date, durations and notes across a type switch', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09', { state, tickets: TICKETS });
        const el = (id: string) => blockById(view, id)?.element as Record<string, unknown>;
        expect(el(SLACK_BLOCK_TS_DATE).initial_date).toBe('2026-09-01');
        expect((el(SLACK_BLOCK_TS_BILLABLE).initial_option as { value: string }).value).toBe('150');
        expect((el(SLACK_BLOCK_TS_NON_BILLABLE).initial_option as { value: string }).value).toBe('30');
        expect(el(SLACK_BLOCK_TS_DESCRIPTION).initial_value).toBe('Paired on the routing bug');
    });

    it('keeps the selected project and ticket', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09', { state, tickets: TICKETS });
        const proj = blockById(view, SLACK_BLOCK_TS_PROJECT)?.element as {
            initial_option?: { value?: string };
        };
        const tic = blockById(view, SLACK_BLOCK_TS_TICKET)?.element as {
            initial_option?: { value?: string };
        };
        expect(proj.initial_option?.value).toBe(PROJECTS[1].id);
        expect(tic.initial_option?.value).toBe(TICKETS[0].id);
    });

    it('drops a stale ticket selection when it is not in the new project list', () => {
        // Switching project must not re-seed a ticket from the OLD project —
        // Slack rejects an initial_option that is not among the options, and
        // submitting it would log against another project's task.
        const view = buildLogTimeModal(PROJECTS, '2026-09-09', {
            state: { ...state, ticket_id: 'ffffffffffffffffffffffff' },
            tickets: TICKETS,
        });
        const tic = blockById(view, SLACK_BLOCK_TS_TICKET)?.element as {
            initial_option?: { value?: string };
        };
        expect(tic.initial_option).toBeUndefined();
    });

    it('keeps the context text when the type is General', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09', {
            state: { entry_type: SLACK_TS_TYPE_GENERAL, context: 'Standup' },
        });
        const el = blockById(view, SLACK_BLOCK_TS_CONTEXT)?.element as { initial_value?: string };
        expect(el.initial_value).toBe('Standup');
    });
});

describe('readLogTimeState', () => {
    it('reads raw values back out of a view for re-rendering', () => {
        const view = {
            state: {
                values: {
                    [SLACK_BLOCK_TS_DATE]: { [SLACK_BLOCK_TS_DATE]: { selected_date: '2026-09-01' } },
                    [SLACK_BLOCK_TS_TYPE]: {
                        [SLACK_BLOCK_TS_TYPE]: { selected_option: { value: SLACK_TS_TYPE_TICKET } },
                    },
                    [SLACK_BLOCK_TS_PROJECT]: {
                        [SLACK_BLOCK_TS_PROJECT]: { selected_option: { value: PROJECTS[0].id } },
                    },
                    [SLACK_BLOCK_TS_TICKET]: {
                        [SLACK_BLOCK_TS_TICKET]: { selected_option: { value: TICKETS[0].id } },
                    },
                    [SLACK_BLOCK_TS_BILLABLE]: {
                        [SLACK_BLOCK_TS_BILLABLE]: { selected_option: { value: '195' } },
                    },
                    [SLACK_BLOCK_TS_DESCRIPTION]: { [SLACK_BLOCK_TS_DESCRIPTION]: { value: 'note' } },
                },
            },
        };
        expect(readLogTimeState(view)).toMatchObject({
            entry_type: SLACK_TS_TYPE_TICKET,
            local_date: '2026-09-01',
            project_id: PROJECTS[0].id,
            ticket_id: TICKETS[0].id,
            billable: '195',
            description: 'note',
        });
    });

    it('defaults to General when the type block is absent', () => {
        expect(readLogTimeState({ state: { values: {} } }).entry_type).toBe(SLACK_TS_TYPE_GENERAL);
    });
});

describe('parseLogTimeSubmission — ticket and context', () => {
    it('returns the ticket id and entry type on a ticket entry', () => {
        const view = viewWith({
            [SLACK_BLOCK_TS_TYPE]: {
                [SLACK_BLOCK_TS_TYPE]: { selected_option: { value: SLACK_TS_TYPE_TICKET } },
            },
            [SLACK_BLOCK_TS_TICKET]: {
                [SLACK_BLOCK_TS_TICKET]: { selected_option: { value: TICKETS[0].id } },
            },
        });
        expect(parseLogTimeSubmission(view)).toMatchObject({
            entry_type: SLACK_TS_TYPE_TICKET,
            task_id: TICKETS[0].id,
        });
    });

    it('returns the context as general_category on a general entry', () => {
        const view = viewWith({
            [SLACK_BLOCK_TS_CONTEXT]: { [SLACK_BLOCK_TS_CONTEXT]: { value: 'Standup' } },
        });
        expect(parseLogTimeSubmission(view)).toMatchObject({
            entry_type: SLACK_TS_TYPE_GENERAL,
            general_category: 'Standup',
        });
    });

    it('an empty context is null, not an empty string the validator would reject', () => {
        const view = viewWith({
            [SLACK_BLOCK_TS_CONTEXT]: { [SLACK_BLOCK_TS_CONTEXT]: { value: '   ' } },
        });
        expect(parseLogTimeSubmission(view).general_category).toBeNull();
    });
});

// ─── Duration pickers ─────────────────────────────────────────────────────
//
// Billable / non-billable are preset dropdowns, not a decimal-hours box.
// The option list mirrors the web `DurationSelect` exactly (15-min steps
// under an hour, 30-min to 8h, hourly to 24h) so the two surfaces never
// offer different choices for the same field.

describe('duration selects', () => {
    const durationBlock = (view: Record<string, unknown>, id: string) =>
        (view.blocks as BlockLike[]).find((b) => b.block_id === id)!;

    it('billable is a select, not a number input', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09');
        expect(durationBlock(view, SLACK_BLOCK_TS_BILLABLE).element.type).toBe('static_select');
    });

    it('non-billable is a select too', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09');
        expect(durationBlock(view, SLACK_BLOCK_TS_NON_BILLABLE).element.type).toBe('static_select');
    });

    it('offers the same presets the web picker does, labelled the same way', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09');
        const labels = (
            durationBlock(view, SLACK_BLOCK_TS_BILLABLE).element.options as Array<{
                text: { text: string };
            }>
        ).map((o) => o.text.text);
        expect(labels).toContain('15 min');
        expect(labels).toContain('45 min');
        expect(labels).toContain('1 hr');
        expect(labels).toContain('1.5 hr');
        expect(labels).toContain('8 hr');
        expect(labels).toContain('24 hr');
        // 30-min granularity stops at 8h; 8.5 would mean the hourly tail is wrong.
        expect(labels).not.toContain('8.5 hr');
    });

    it('leads with a zero option so "no time on this side" is selectable', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09');
        const opts = durationBlock(view, SLACK_BLOCK_TS_BILLABLE).element.options as Array<{
            value: string;
            text: { text: string };
        }>;
        expect(opts[0]!.value).toBe('0');
        expect(opts[0]!.text.text).toBe('—');
    });

    it('stays under Slack’s option ceiling', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09');
        const opts = durationBlock(view, SLACK_BLOCK_TS_BILLABLE).element.options as unknown[];
        expect(opts.length).toBeLessThanOrEqual(100);
    });

    it('defaults both sides to zero', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09');
        for (const id of [SLACK_BLOCK_TS_BILLABLE, SLACK_BLOCK_TS_NON_BILLABLE]) {
            const el = durationBlock(view, id).element as { initial_option?: { value?: string } };
            expect(el.initial_option?.value).toBe('0');
        }
    });

    it('re-seeds the chosen duration across a views.update', () => {
        const view = buildLogTimeModal(PROJECTS, '2026-09-09', {
            state: { billable: '150', non_billable: '30' },
        });
        const b = durationBlock(view, SLACK_BLOCK_TS_BILLABLE).element as {
            initial_option?: { value?: string; text?: { text?: string } };
        };
        expect(b.initial_option?.value).toBe('150');
        expect(b.initial_option?.text?.text).toBe('2.5 hr');
    });

    it('drops a re-seed that is not one of the presets rather than being rejected', () => {
        // Slack refuses a view whose initial_option is absent from options.
        // A legacy "1:05" style value must therefore fall back, not crash.
        const view = buildLogTimeModal(PROJECTS, '2026-09-09', { state: { billable: '65' } });
        const b = durationBlock(view, SLACK_BLOCK_TS_BILLABLE).element as {
            initial_option?: { value?: string };
        };
        expect(b.initial_option?.value).toBe('0');
    });
});

describe('parseLogTimeSubmission — durations from the select', () => {
    const withDurations = (billable: string, nonBillable: string) =>
        viewWith({
            [SLACK_BLOCK_TS_BILLABLE]: {
                [SLACK_BLOCK_TS_BILLABLE]: { selected_option: { value: billable } },
            },
            [SLACK_BLOCK_TS_NON_BILLABLE]: {
                [SLACK_BLOCK_TS_NON_BILLABLE]: { selected_option: { value: nonBillable } },
            },
        });

    it('converts selected minutes into hours + minutes', () => {
        expect(parseLogTimeSubmission(withDurations('150', '30'))).toMatchObject({
            billable_hours: 2,
            billable_minutes: 30,
            non_billable_hours: 0,
            non_billable_minutes: 30,
        });
    });

    it('reads the zero option as zero, not as missing', () => {
        expect(parseLogTimeSubmission(withDurations('0', '0'))).toMatchObject({
            billable_hours: 0,
            billable_minutes: 0,
            non_billable_hours: 0,
            non_billable_minutes: 0,
        });
    });

    it('a full 24h option maps to 24h, not 23h 60m', () => {
        expect(parseLogTimeSubmission(withDurations('1440', '0'))).toMatchObject({
            billable_hours: 24,
            billable_minutes: 0,
        });
    });
});
