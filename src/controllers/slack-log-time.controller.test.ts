import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES } from '../constants/roles.js';
import { AppError } from '../utils/app-error.js';
import {
    SLACK_BLOCK_TS_BILLABLE,
    SLACK_BLOCK_TS_DATE,
    SLACK_BLOCK_TS_DESCRIPTION,
    SLACK_BLOCK_TS_PROJECT,
} from '../constants/slack.js';

const {
    createEntryMock,
    resolveSlackUserMock,
    loadProjectsMock,
    postMessageMock,
    publishHomeMock,
    openModalMock,
    callerCanLogTimeMock,
    loggerWarnMock,
    loggerErrorMock,
} = vi.hoisted(() => ({
    createEntryMock: vi.fn(),
    resolveSlackUserMock: vi.fn(),
    loadProjectsMock: vi.fn(),
    postMessageMock: vi.fn(),
    publishHomeMock: vi.fn(),
    openModalMock: vi.fn(),
    callerCanLogTimeMock: vi.fn(),
    loggerWarnMock: vi.fn(),
    loggerErrorMock: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
    default: { warn: loggerWarnMock, error: loggerErrorMock, info: vi.fn() },
}));
vi.mock('../services/timesheet.service.js', () => ({ createEntry: createEntryMock }));
vi.mock('../services/slack-user-mapping.service.js', () => ({ resolveSlackCaller: resolveSlackUserMock }));
vi.mock('../services/slack-timesheet.service.js', () => ({
    loadLogTimeProjects: loadProjectsMock,
    callerCanLogTime: callerCanLogTimeMock,
}));
vi.mock('../services/settings.service.js', () => ({ getOrInitSettings: vi.fn().mockResolvedValue({ slack: {} }) }));
vi.mock('../services/slack-home.service.js', () => ({ buildHomeDashboardData: vi.fn().mockResolvedValue({}) }));
vi.mock('../utils/slack-home-blocks.js', () => ({
    buildHomeDashboardView: vi.fn(() => ({ type: 'home', blocks: [] })),
}));
vi.mock('../utils/slack.js', () => ({
    slackContextFrom: vi.fn().mockReturnValue({ enabled: true, botToken: 'xoxb-test' }),
    postSlackMessage: postMessageMock,
    publishHomeView: publishHomeMock,
    openSlackModal: openModalMock,
}));

const { handleLogTimeSubmission, openLogTimeModal } = await import('./slack-log-time.controller.js');

const USER = { _id: new Types.ObjectId(), role: ROLES.EMPLOYEE, full_name: 'Ananya' };
const PROJECT_ID = new Types.ObjectId().toString();

const submission = (over: Record<string, unknown> = {}) => ({
    body: {
        payload: JSON.stringify({
            type: 'view_submission',
            user: { id: 'U123' },
            view: {
                callback_id: 'log_time_submit',
                state: {
                    values: {
                        [SLACK_BLOCK_TS_DATE]: { [SLACK_BLOCK_TS_DATE]: { selected_date: '2026-09-07' } },
                        [SLACK_BLOCK_TS_PROJECT]: {
                            [SLACK_BLOCK_TS_PROJECT]: { selected_option: { value: PROJECT_ID } },
                        },
                        [SLACK_BLOCK_TS_BILLABLE]: { [SLACK_BLOCK_TS_BILLABLE]: { value: '3.5' } },
                        ts_non_billable: { ts_non_billable: { value: '0' } },
                        [SLACK_BLOCK_TS_DESCRIPTION]: {
                            [SLACK_BLOCK_TS_DESCRIPTION]: { value: 'Depot routing bug' },
                        },
                        ...over,
                    },
                },
            },
        }),
    },
    headers: {},
});

const resStub = () => {
    const res: any = {};
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res;
};

beforeEach(() => {
    vi.clearAllMocks();
    resolveSlackUserMock.mockResolvedValue(USER);
    createEntryMock.mockResolvedValue({
        data: { id: 'entry-1', total_minutes: 210 },
        warnings: { exceeds_daily_threshold: false, overlaps_approved_leave: false },
    });
    openModalMock.mockResolvedValue(true);
    loadProjectsMock.mockResolvedValue([{ id: PROJECT_ID, label: 'Nordmark Fleet Dashboard' }]);
    callerCanLogTimeMock.mockResolvedValue(true);
});

describe('handleLogTimeSubmission', () => {
    it('creates a general entry against the chosen project', async () => {
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());

        expect(createEntryMock).toHaveBeenCalledTimes(1);
        const [body, caller] = createEntryMock.mock.calls[0]!;
        expect(body).toMatchObject({
            entry_type: 'general',
            local_date: '2026-09-07',
            project_id: PROJECT_ID,
            general_category: null,
            billable_hours: 3,
            billable_minutes: 30,
            non_billable_hours: 0,
            non_billable_minutes: 0,
            description: 'Depot routing bug',
        });
        expect(String(caller.id)).toBe(String(USER._id));
    });

    it('closes the modal on success', async () => {
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());
        expect(res.json).toHaveBeenCalledWith({});
    });

    it('republishes the Home tab so the total updates', async () => {
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());
        await new Promise((r) => setImmediate(r));
        expect(publishHomeMock).toHaveBeenCalled();
    });

    it('DMs soft warnings instead of dropping them', async () => {
        createEntryMock.mockResolvedValue({
            data: { id: 'entry-1', total_minutes: 840 },
            warnings: { exceeds_daily_threshold: true, overlaps_approved_leave: false },
        });
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());
        await new Promise((r) => setImmediate(r));

        expect(postMessageMock).toHaveBeenCalled();
        const arg = postMessageMock.mock.calls[0]![1];
        expect(arg.channel).toBe('U123');
        expect(String(arg.text)).toMatch(/daily/i);
    });

    it('sends no DM when there are no warnings', async () => {
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());
        await new Promise((r) => setImmediate(r));
        expect(postMessageMock).not.toHaveBeenCalled();
    });

    it('shows a future date as an inline error on the date block', async () => {
        createEntryMock.mockRejectedValue(
            new AppError({
                statusCode: 422,
                code: ERROR_CODES.TIMESHEET_FUTURE_DATE,
                message: "You can't log time for a future date.",
            })
        );
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());

        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                response_action: 'errors',
                errors: expect.objectContaining({ [SLACK_BLOCK_TS_DATE]: expect.any(String) }),
            })
        );
    });

    // Finding 4 — a raw driver error (Mongo, network, anything not an
    // AppError) must not leak its message to the user, and must be logged
    // as the unexpected failure it is (error, not warn).
    it('shows a generic message (not the raw driver error) when createEntry throws something other than AppError', async () => {
        createEntryMock.mockRejectedValue(new Error('E11000 duplicate key error collection: timesheet_entries'));
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());

        const arg = res.json.mock.calls[0]![0];
        expect(arg.response_action).toBe('errors');
        const shown = Object.values(arg.errors as Record<string, string>).join(' ');
        expect(shown).not.toMatch(/E11000|duplicate key|collection/i);
        expect(shown.length).toBeGreaterThan(0);
    });

    it('logs an unexpected (non-AppError) createEntry failure at error, not warn', async () => {
        createEntryMock.mockRejectedValue(new Error('ECONNRESET'));
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());

        expect(loggerErrorMock).toHaveBeenCalledTimes(1);
        expect(loggerWarnMock).not.toHaveBeenCalled();
    });

    it('still logs a known AppError rejection at warn (not error) and shows its real message', async () => {
        createEntryMock.mockRejectedValue(
            new AppError({
                statusCode: 422,
                code: ERROR_CODES.TIMESHEET_ZERO_DURATION,
                message: 'Log at least some time.',
            })
        );
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());

        expect(loggerWarnMock).toHaveBeenCalledTimes(1);
        expect(loggerErrorMock).not.toHaveBeenCalled();
        const arg = res.json.mock.calls[0]![0];
        expect(JSON.stringify(arg.errors)).toContain('Log at least some time.');
    });

    it('rejects an empty description inline without calling the service', async () => {
        const res = resStub();
        await handleLogTimeSubmission(
            submission({ [SLACK_BLOCK_TS_DESCRIPTION]: { [SLACK_BLOCK_TS_DESCRIPTION]: { value: '   ' } } }) as never,
            res,
            vi.fn()
        );

        expect(createEntryMock).not.toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                response_action: 'errors',
                errors: expect.objectContaining({ [SLACK_BLOCK_TS_DESCRIPTION]: expect.any(String) }),
            })
        );
    });

    it('refuses a Client role (no timesheet.write) and never calls createEntry', async () => {
        resolveSlackUserMock.mockResolvedValue({ ...USER, role: ROLES.CLIENT });
        callerCanLogTimeMock.mockResolvedValue(false);
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());

        expect(createEntryMock).not.toHaveBeenCalled();
        const arg = res.json.mock.calls[0]![0];
        expect(arg.response_action).toBe('errors');
        expect(JSON.stringify(arg.errors)).toMatch(/your role can't log time/i);
    });

    it('refuses a Representative role (no timesheet.write) and never calls createEntry', async () => {
        resolveSlackUserMock.mockResolvedValue({ ...USER, role: ROLES.REPRESENTATIVE });
        callerCanLogTimeMock.mockResolvedValue(false);
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());

        expect(createEntryMock).not.toHaveBeenCalled();
    });

    // Round-3 finding: the old enforcement gate was role-based
    // (`!CLIENT_SIDE_ROLES.includes(role)`), which fails OPEN for a
    // supported RBAC configuration — `assignRolesToUser` (role.service.ts)
    // leaves the legacy `User.role` field unchanged (typically 'employee')
    // when an admin assigns a user ONLY custom roles, so a caller whose
    // custom role deliberately excludes `timesheet.write` still carried a
    // non-client-side `role` and would have PASSED the old check. This test
    // pins USER's real role (employee — not client-side at all) while the
    // permission resolver says NO timesheet.write, proving the gate now
    // asks the permission question that `slack-home.service.ts` also asks
    // for rendering, not the legacy role field.
    it('refuses a caller whose role is not client-side but who lacks timesheet.write (restricted custom role)', async () => {
        callerCanLogTimeMock.mockResolvedValue(false);
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());

        expect(createEntryMock).not.toHaveBeenCalled();
        const arg = res.json.mock.calls[0]![0];
        expect(arg.response_action).toBe('errors');
        expect(JSON.stringify(arg.errors)).toMatch(/your role can't log time/i);
    });

    it('tells an unrecognised Slack user what to do', async () => {
        resolveSlackUserMock.mockResolvedValue(null);
        const res = resStub();
        await handleLogTimeSubmission(submission() as never, res, vi.fn());

        expect(createEntryMock).not.toHaveBeenCalled();
        const arg = res.json.mock.calls[0]![0];
        expect(arg.response_action).toBe('errors');
        expect(JSON.stringify(arg.errors)).toMatch(/identify your Viljetech account/i);
    });

    it('surfaces a visible error on the description block for a project-less caller (no ts_project in their view)', async () => {
        // buildLogTimeModal never renders SLACK_BLOCK_TS_PROJECT for a caller
        // with no projects, so this handler always sends general_category:
        // null for a general entry — a project-less caller's submission
        // therefore always trips the schema's "pick a project or name a
        // category" refine at path ['general_category'], which FIELD_TO_BLOCK
        // maps to SLACK_BLOCK_TS_PROJECT. Without guardModalErrors that error
        // targets a block absent from the view, and Slack drops it silently —
        // the modal just sits there with no feedback. This is the case the
        // guard exists to close.
        const res = resStub();
        const req = {
            body: {
                payload: JSON.stringify({
                    type: 'view_submission',
                    user: { id: 'U123' },
                    view: {
                        callback_id: 'log_time_submit',
                        state: {
                            values: {
                                [SLACK_BLOCK_TS_DATE]: { [SLACK_BLOCK_TS_DATE]: { selected_date: '2026-09-07' } },
                                [SLACK_BLOCK_TS_BILLABLE]: { [SLACK_BLOCK_TS_BILLABLE]: { value: '3.5' } },
                                ts_non_billable: { ts_non_billable: { value: '0' } },
                                [SLACK_BLOCK_TS_DESCRIPTION]: {
                                    [SLACK_BLOCK_TS_DESCRIPTION]: { value: 'Depot routing bug' },
                                },
                                // No ts_project entry at all.
                            },
                        },
                    },
                }),
            },
            headers: {},
        };

        await handleLogTimeSubmission(req as never, res, vi.fn());

        expect(createEntryMock).not.toHaveBeenCalled();
        const arg = res.json.mock.calls[0]![0];
        expect(arg.response_action).toBe('errors');
        // Must land on the block that's actually present, not the absent
        // project block — assert the exact key, not just "some error".
        expect(Object.keys(arg.errors)).toEqual([SLACK_BLOCK_TS_DESCRIPTION]);
    });
});

describe('openLogTimeModal', () => {
    it('opens a modal populated with the caller’s projects', async () => {
        await expect(openLogTimeModal('trigger-1', USER as never)).resolves.toBeNull();

        expect(loadProjectsMock).toHaveBeenCalled();
        const [, triggerId, view] = openModalMock.mock.calls[0]!;
        expect(triggerId).toBe('trigger-1');
        expect(JSON.stringify(view)).toContain('Nordmark Fleet Dashboard');
    });

    it('reports a message when Slack refuses to open the modal', async () => {
        openModalMock.mockResolvedValue(false);
        await expect(openLogTimeModal('trigger-1', USER as never)).resolves.toEqual(expect.any(String));
    });

    it('guards a missing trigger_id without hitting Slack', async () => {
        await expect(openLogTimeModal(undefined, USER as never)).resolves.toEqual(expect.any(String));
        expect(openModalMock).not.toHaveBeenCalled();
    });
});
