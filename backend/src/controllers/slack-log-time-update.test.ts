import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { Request, Response } from 'express';

import {
    SLACK_BLOCK_TS_PROJECT,
    SLACK_BLOCK_TS_TICKET,
    SLACK_BLOCK_TS_TYPE,
    SLACK_CALLBACK_LOG_TIME,
    SLACK_TS_TYPE_GENERAL,
    SLACK_TS_TYPE_TICKET,
} from '../constants/slack.js';

/**
 * The `views.update` branch: a `block_actions` raised INSIDE the log-time
 * modal, which the controller answers by re-rendering the modal.
 *
 * Before this existed the controller only handled actions originating from
 * the App Home tab or a message, so a select inside a modal had nowhere to
 * go. The two triggers are the Type select (swap Ticket ↔ Context) and the
 * Project select (repopulate the ticket list).
 */

vi.mock('../services/settings.service.js', () => ({ getOrInitSettings: vi.fn() }));
vi.mock('../services/slack-user-mapping.service.js', () => ({
    resolveSlackCaller: vi.fn(),
    fetchSlackUserInfo: vi.fn(),
}));

const updateSlackModalMock = vi.fn(async () => true);
vi.mock('../utils/slack.js', async (orig) => ({
    ...(await orig<typeof import('../utils/slack.js')>()),
    slackContextFrom: vi.fn(() => ({ enabled: true, botToken: 'xoxb' })),
    updateSlackModal: (...a: unknown[]) => updateSlackModalMock(...(a as [])),
}));

const loadLogTimeProjectsMock = vi.fn(async () => [{ id: 'p1', label: 'Nordmark' }]);
const loadLogTimeTicketsMock = vi.fn(async () => [{ id: 't1', label: 'VLJ-1 Fix' }]);
vi.mock('../services/slack-timesheet.service.js', () => ({
    callerCanLogTime: vi.fn(async () => true),
    loadLogTimeProjects: (...a: unknown[]) => loadLogTimeProjectsMock(...(a as [])),
    loadLogTimeTickets: (...a: unknown[]) => loadLogTimeTicketsMock(...(a as [])),
}));

import { getOrInitSettings } from '../services/settings.service.js';
import { resolveSlackCaller } from '../services/slack-user-mapping.service.js';
import { handleInteractive as raw } from './slack-interactive.controller.js';

const handleInteractive = raw as (req: Request, res: Response) => Promise<void>;

const makeRes = () => {
    const res = {} as { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
};

const userId = new Types.ObjectId();

/** A block_actions raised inside the log-time modal. */
const modalAction = (actionId: string, values: Record<string, unknown>) => ({
    body: {
        payload: JSON.stringify({
            type: 'block_actions',
            user: { id: 'U1' },
            actions: [{ action_id: actionId }],
            view: {
                id: 'V123',
                hash: 'HASH1',
                type: 'modal',
                callback_id: SLACK_CALLBACK_LOG_TIME,
                state: { values },
            },
        }),
    },
});

const typeCell = (v: string) => ({
    [SLACK_BLOCK_TS_TYPE]: { [SLACK_BLOCK_TS_TYPE]: { selected_option: { value: v } } },
});
const projCell = (v: string) => ({
    [SLACK_BLOCK_TS_PROJECT]: { [SLACK_BLOCK_TS_PROJECT]: { selected_option: { value: v } } },
});

beforeEach(() => {
    vi.clearAllMocks();
    updateSlackModalMock.mockResolvedValue(true);
    loadLogTimeProjectsMock.mockResolvedValue([{ id: 'p1', label: 'Nordmark' }]);
    loadLogTimeTicketsMock.mockResolvedValue([{ id: 't1', label: 'VLJ-1 Fix' }]);
    (getOrInitSettings as ReturnType<typeof vi.fn>).mockResolvedValue({ slack: { enabled: true } });
    (resolveSlackCaller as ReturnType<typeof vi.fn>).mockResolvedValue({ _id: userId, role: 'employee' });
});

describe('log-time modal — views.update branch', () => {
    it("switching to Ticket loads that project's tickets and re-renders", async () => {
        const res = makeRes();
        await handleInteractive(
            modalAction(SLACK_BLOCK_TS_TYPE, {
                ...typeCell(SLACK_TS_TYPE_TICKET),
                ...projCell('6a5dd789cb47f588a23516e7'),
            }) as unknown as Request,
            res as unknown as Response
        );
        expect(loadLogTimeTicketsMock).toHaveBeenCalledWith('6a5dd789cb47f588a23516e7', expect.anything());
        expect(updateSlackModalMock).toHaveBeenCalled();
    });

    it('passes the view id and hash so a concurrent edit is not clobbered', async () => {
        const res = makeRes();
        await handleInteractive(
            modalAction(SLACK_BLOCK_TS_TYPE, typeCell(SLACK_TS_TYPE_TICKET)) as unknown as Request,
            res as unknown as Response
        );
        const [, viewId, , , hash] = updateSlackModalMock.mock.calls[0] as unknown as unknown[];
        expect(viewId).toBe('V123');
        expect(hash).toBe('HASH1');
    });

    it('switching to General does not query tickets at all', async () => {
        const res = makeRes();
        await handleInteractive(
            modalAction(SLACK_BLOCK_TS_TYPE, {
                ...typeCell(SLACK_TS_TYPE_GENERAL),
                ...projCell('6a5dd789cb47f588a23516e7'),
            }) as unknown as Request,
            res as unknown as Response
        );
        expect(loadLogTimeTicketsMock).not.toHaveBeenCalled();
        expect(updateSlackModalMock).toHaveBeenCalled();
    });

    it('changing project while on Ticket repopulates the list', async () => {
        const res = makeRes();
        await handleInteractive(
            modalAction(SLACK_BLOCK_TS_PROJECT, {
                ...typeCell(SLACK_TS_TYPE_TICKET),
                ...projCell('6a5dd7a2cb47f588a2351721'),
            }) as unknown as Request,
            res as unknown as Response
        );
        expect(loadLogTimeTicketsMock).toHaveBeenCalledWith('6a5dd7a2cb47f588a2351721', expect.anything());
    });

    it('Ticket with no project selected yet does not query, and still re-renders', async () => {
        const res = makeRes();
        await handleInteractive(
            modalAction(SLACK_BLOCK_TS_TYPE, typeCell(SLACK_TS_TYPE_TICKET)) as unknown as Request,
            res as unknown as Response
        );
        expect(loadLogTimeTicketsMock).not.toHaveBeenCalled();
        expect(updateSlackModalMock).toHaveBeenCalled();
    });

    it('always acks 200 — Slack retries anything else', async () => {
        const res = makeRes();
        await handleInteractive(
            modalAction(SLACK_BLOCK_TS_TYPE, typeCell(SLACK_TS_TYPE_TICKET)) as unknown as Request,
            res as unknown as Response
        );
        expect(res.status).toHaveBeenCalledWith(200);
    });

    it('an unresolvable Slack user acks without attempting an update', async () => {
        (resolveSlackCaller as ReturnType<typeof vi.fn>).mockResolvedValue(null);
        const res = makeRes();
        await handleInteractive(
            modalAction(SLACK_BLOCK_TS_TYPE, typeCell(SLACK_TS_TYPE_TICKET)) as unknown as Request,
            res as unknown as Response
        );
        expect(res.status).toHaveBeenCalledWith(200);
        expect(updateSlackModalMock).not.toHaveBeenCalled();
    });

    it('a ticket select change is ignored — only type and project re-render', async () => {
        // Picking a ticket must NOT trigger views.update: it changes nothing
        // about which blocks are shown, and re-rendering mid-choice would be
        // a pointless round-trip the user sees as a flicker.
        const res = makeRes();
        await handleInteractive(
            modalAction(SLACK_BLOCK_TS_TICKET, typeCell(SLACK_TS_TYPE_TICKET)) as unknown as Request,
            res as unknown as Response
        );
        expect(updateSlackModalMock).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
    });
});
