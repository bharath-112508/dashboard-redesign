import type { RequestHandler } from 'express';
import { Types } from 'mongoose';

import { TIMESHEET_ENTRY_TYPES } from '../constants/timesheet.js';
import type { RoleType } from '../constants/roles.js';
import { buildHomeDashboardData } from '../services/slack-home.service.js';
import { getOrInitSettings } from '../services/settings.service.js';
import { callerCanLogTime, loadLogTimeProjects, loadLogTimeTickets } from '../services/slack-timesheet.service.js';
import { resolveSlackCaller } from '../services/slack-user-mapping.service.js';
import { createEntry } from '../services/timesheet.service.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import logger from '../utils/logger.js';
import { buildHomeDashboardView } from '../utils/slack-home-blocks.js';
import {
    buildLogTimeModal,
    guardModalErrors,
    parseLogTimeSubmission,
    readLogTimeState,
    timesheetAppErrorToModalErrors,
} from '../utils/slack-block-kit/timesheet.js';
import {
    SLACK_BLOCK_TS_BILLABLE,
    SLACK_BLOCK_TS_CONTEXT,
    SLACK_BLOCK_TS_DATE,
    SLACK_BLOCK_TS_DESCRIPTION,
    SLACK_BLOCK_TS_NON_BILLABLE,
    SLACK_BLOCK_TS_PROJECT,
    SLACK_BLOCK_TS_TICKET,
    SLACK_TS_TYPE_TICKET,
} from '../constants/slack.js';
import type { SlackContext } from '../utils/slack.js';
import {
    openSlackModal,
    postSlackMessage,
    publishHomeView,
    slackContextFrom,
    updateSlackModal,
} from '../utils/slack.js';
import { createTimesheetBodySchema } from '../validators/timesheet.validator.js';

/**
 * Slack "Log time" modal — open and submit.
 *
 * Separate from `slack-interactive.controller.ts`, which is already 700+
 * lines with the apply-leave handler inline. That controller keeps only the
 * routing branches (Task 5); the work lives here.
 *
 * UNLIKE apply-leave, this handler does NOT ack first. `applyLeave` awaits a
 * notification fan-out (in-app + email + Slack DM) that blows the ~3s
 * `view_submission` budget, so it must respond before doing the work — at the
 * cost of never being able to show an inline field error. `createEntry` does
 * no fan-out (reads, one insert, one aggregate, one audit row), so this runs
 * inline and keeps inline errors, which is the whole point of a form.
 */

interface SlackCaller {
    _id: Types.ObjectId;
    role: RoleType;
}

const UNKNOWN_USER =
    "Couldn't identify your Viljetech account. Set your Slack email on your profile or contact an admin.";

const NO_TIMESHEET_ACCESS = "Your role can't log time in Slack.";

const todayIso = (): string => dayjs().tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD');

/** Open the modal. Returns a user-facing message on failure, else null. */
export const openLogTimeModal = async (triggerId: string | undefined, user: SlackCaller): Promise<string | null> => {
    if (!triggerId) return 'Sorry, something went wrong.';
    const settings = await getOrInitSettings();
    const ctx = slackContextFrom(settings.slack);
    if (!ctx) return 'Slack is not configured.';

    const projects = await loadLogTimeProjects({ id: user._id, role: user.role });
    const opened = await openSlackModal(ctx, triggerId, buildLogTimeModal(projects, todayIso()), 'log-time-modal-open');
    return opened ? null : "Couldn't open the log-time form. Please try again.";
};

/** Re-render the Home tab so the new total shows. Never throws. Takes an
 *  already-resolved `ctx` so the fire-and-forget tail below fetches Slack
 *  settings once per submission instead of once per side-effect. */
const republishHome = async (ctx: SlackContext | null, slackUserId: string, user: SlackCaller): Promise<void> => {
    if (!ctx) return;
    try {
        const data = await buildHomeDashboardData(user);
        await publishHomeView(ctx, slackUserId, buildHomeDashboardView(data, user), 'log_time');
    } catch (err) {
        logger.warn({ err, reason: 'log_time_home_refresh_failed' }, 'Slack log-time: Home refresh failed');
    }
};

/**
 * Re-render the open modal after a Type or Project change.
 *
 * Slack does not do conditional fields: a modal's blocks are fixed at render
 * time, so "show the Ticket select only for a ticket entry" means replacing
 * the view. The two selects carry `dispatch_action: true` (see the builder)
 * and land here.
 *
 * Everything already typed is read back off the submitted view and handed to
 * the builder as `initial_*` — `views.update` REPLACES the blocks and keeps
 * none of the entered values, so skipping that step silently wipes the
 * user's date, hours and notes the moment they touch the type select.
 *
 * Failure is survivable and deliberately quiet: the modal keeps showing its
 * previous blocks, which is still a submittable form. There is nothing to
 * tell the user that would help — a DM about a dropdown they are looking at
 * would be noise — so this logs and returns.
 */
export const handleLogTimeModalChange = async (
    payload: {
        user: { id: string };
        actions?: Array<{ action_id?: string }>;
        view?: { id?: string; hash?: string; state?: unknown };
    },
    user: SlackCaller
): Promise<void> => {
    const viewId = payload.view?.id;
    if (!viewId) return;

    const settings = await getOrInitSettings();
    const ctx = slackContextFrom(settings.slack);
    if (!ctx) return;

    const state = readLogTimeState(payload.view);
    const projects = await loadLogTimeProjects({ id: user._id, role: user.role });

    // Only fetch tickets when they will actually be rendered. On General the
    // block is not shown, and with no project chosen there is nothing to
    // scope the query by — the builder renders guidance for both cases.
    const tickets =
        state.entry_type === SLACK_TS_TYPE_TICKET && state.project_id
            ? await loadLogTimeTickets(state.project_id, { id: user._id, role: user.role })
            : [];

    await updateSlackModal(
        ctx,
        viewId,
        buildLogTimeModal(projects, todayIso(), { state, tickets }),
        'log-time-modal-update',
        payload.view?.hash
    );
};

/**
 * Map a `createTimesheetBodySchema` Zod issue's field path onto a block id
 * IN THE LOG-TIME MODAL. Slack silently drops an error keyed to a block
 * that isn't in the view (see `timesheetAppErrorToModalErrors`'s doc
 * comment), so this can't just be `ts_${field}` — most validator field
 * names don't match a block id 1:1 in this modal (e.g. `billable_hours` and
 * `billable_minutes` both land on the one `ts_billable` decimal-hours
 * input). That distinction matters concretely: `toHoursMinutes` (the
 * decimal→hours/minutes conversion) doesn't clamp to `TIMESHEET_HOURS_MAX`,
 * so someone typing 100 billable hours reaches the validator's `.max(24)`
 * check on `billable_hours` — mapped here, that lands back on the billable
 * field instead of silently vanishing.
 */
const FIELD_TO_BLOCK: Record<string, string> = {
    local_date: SLACK_BLOCK_TS_DATE,
    project_id: SLACK_BLOCK_TS_PROJECT,
    // "Ticket" chosen but none picked. Without this the error would fall
    // through to the description block — telling someone their NOTE is wrong
    // when the empty field is the ticket select right above it.
    task_id: SLACK_BLOCK_TS_TICKET,
    // The Context input, which only exists on a general entry. On a ticket
    // entry that block is not rendered and `guardModalErrors` re-keys this
    // to the description block rather than letting Slack drop it.
    general_category: SLACK_BLOCK_TS_CONTEXT,
    billable_hours: SLACK_BLOCK_TS_BILLABLE,
    billable_minutes: SLACK_BLOCK_TS_BILLABLE,
    non_billable_hours: SLACK_BLOCK_TS_NON_BILLABLE,
    non_billable_minutes: SLACK_BLOCK_TS_NON_BILLABLE,
    description: SLACK_BLOCK_TS_DESCRIPTION,
};

export const handleLogTimeSubmission: RequestHandler = async (req, res) => {
    const payload = JSON.parse((req.body as { payload: string }).payload) as {
        user: { id: string };
        view: unknown;
    };
    const slackUserId = payload.user.id;

    const user = (await resolveSlackCaller(slackUserId)) as SlackCaller | null;
    if (!user) {
        res.status(200).json({
            response_action: 'errors',
            errors: { [SLACK_BLOCK_TS_DESCRIPTION]: UNKNOWN_USER },
        });
        return;
    }

    // The open branch already refuses a caller without `timesheet.write`
    // before the modal ever renders, but that's UI-layer only — a forged
    // `view_submission` (crafted `state.values`, `callback_id:
    // 'log_time_submit'`) can reach this handler directly, and `createEntry`
    // below has no permission check of its own. This is the real gate.
    if (!(await callerCanLogTime(user._id))) {
        res.status(200).json({
            response_action: 'errors',
            errors: { [SLACK_BLOCK_TS_DESCRIPTION]: NO_TIMESHEET_ACCESS },
        });
        return;
    }

    // Reuse the HTTP validator so Slack input gets identical validation and
    // defaults — the description-required rule lives there, not on the model.
    // The Slack-facing type ('general' | 'ticket') maps onto the persisted
    // `entry_type` here and nowhere else, so the two vocabularies stay
    // independent. `parseLogTimeSubmission` has already nulled whichever of
    // task_id / general_category does not belong to the chosen branch — the
    // validator is a discriminated union and refuses a task_id on a general
    // entry (and vice versa).
    const submitted = parseLogTimeSubmission(payload.view);
    const isTicketEntry = submitted.entry_type === SLACK_TS_TYPE_TICKET;
    const parsed = createTimesheetBodySchema.safeParse({
        ...submitted,
        entry_type: isTicketEntry ? TIMESHEET_ENTRY_TYPES.TASK_LINKED : TIMESHEET_ENTRY_TYPES.GENERAL,
    });

    if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
            const field = String(issue.path[0] ?? '');
            const block = FIELD_TO_BLOCK[field] ?? SLACK_BLOCK_TS_DESCRIPTION;
            errors[block] = issue.message;
        }
        if (Object.keys(errors).length === 0) {
            errors[SLACK_BLOCK_TS_DESCRIPTION] = 'Please check the form and try again.';
        }
        // Guard against a mapped block (e.g. SLACK_BLOCK_TS_PROJECT for a
        // project-less caller) that isn't actually in this caller's view —
        // Slack would otherwise drop that error with no visible feedback.
        res.status(200).json({ response_action: 'errors', errors: guardModalErrors(errors, payload.view) });
        return;
    }

    const audit = buildAuditContext(req, {
        overrideActor: { actor_id: user._id, actor_role: user.role },
    });

    let warnings: { exceeds_daily_threshold: boolean; overlaps_approved_leave: boolean };
    try {
        const result = await createEntry(parsed.data, { id: user._id, role: user.role, audit });
        warnings = result.warnings;
    } catch (err: unknown) {
        // Only an AppError is a known, user-safe application failure — its
        // `code`/`message` are meant to be shown. Anything else (a raw Mongo
        // driver error, a network blip, a bug) must not leak its message to
        // the modal, and is the unexpected case: log it at error, not warn.
        const isAppError = err instanceof AppError;
        const code = isAppError ? err.code : undefined;
        const message = isAppError ? err.message : 'Could not log your time. Please try again.';
        const logPayload = { err, code, reason: 'log_time_submit_failed' };
        if (isAppError) {
            logger.warn(logPayload, 'Slack log-time submission rejected');
        } else {
            logger.error(logPayload, 'Slack log-time submission rejected');
        }
        res.status(200).json({
            response_action: 'errors',
            errors: timesheetAppErrorToModalErrors(code, message, payload.view),
        });
        return;
    }

    // Written. Close the modal, then do the slow, non-blocking parts.
    res.status(200).json({});

    // Settings/ctx are resolved once here and reused by both republishHome
    // and the warning DM below (was two separate `getOrInitSettings` calls).
    // The whole tail is wrapped in `.catch()` — it runs after the response is
    // already sent, so an unhandled rejection here (e.g. settings lookup
    // throwing) would otherwise be a silent unhandled-rejection with no
    // caller left to see it.
    void (async () => {
        const ctx = await getOrInitSettings()
            .then((settings) => slackContextFrom(settings.slack))
            .catch(() => null);

        await republishHome(ctx, slackUserId, user);

        const notes: string[] = [];
        if (warnings.exceeds_daily_threshold) notes.push("that's over the daily hours threshold");
        if (warnings.overlaps_approved_leave) notes.push('that day overlaps approved leave');
        if (notes.length === 0 || !ctx) return;

        // Success needs no DM — the updated Home total is the confirmation.
        // Warnings would otherwise vanish, so they get one.
        void postSlackMessage(ctx, {
            channel: slackUserId,
            text: `⚠️ Time logged, but ${notes.join(' and ')}.`,
            context: 'log-time-warning-dm',
        });
    })().catch((err: unknown) => {
        logger.warn({ err, reason: 'log_time_async_tail_failed' }, 'Slack log-time: post-submit async work failed');
    });
};
