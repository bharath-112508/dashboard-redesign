import { Types } from 'mongoose';
import { z } from 'zod';

import { ReportSubscription, type ReportSubscriptionDocument } from '../models/report-subscription.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import {
    REPORT_SUBSCRIPTION_ATTACHMENT_MAX_BYTES,
    REPORT_SUBSCRIPTION_MAX_PER_RUN,
    REPORT_SUBSCRIPTION_PER_USER_CAP,
    type ReportSubscriptionOutputFormat,
} from '../constants/report-subscription.js';
import { EXPORT_FORMAT_CONFIG, type ExportFormat, type ReportExportName } from '../constants/export.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { parsePresetFilters } from '../validators/report-preset.validator.js';
import {
    buildAttendanceReport,
    buildBillingReport,
    buildLeaveReport,
    buildUtilizationReport,
} from './report.service.js';
import {
    renderReportSubscriptionAttachmentNotice,
    renderReportSubscriptionEmail,
} from './report-subscription.email.js';
import {
    toTabularAttendance,
    toTabularBilling,
    toTabularLeaves,
    toTabularUtilization,
    type TabularReport,
} from './report-exporters/tabular.js';
import { generateCsv } from './report-exporters/csv.js';
import { generateXlsx } from './report-exporters/xlsx.js';
import { generatePdf } from './report-exporters/pdf.js';
import { recordAudit, recordSystemAudit, type AuditContext } from './audit.service.js';
import { sendEmail, type EmailAttachment } from '../utils/mailer.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import { REPORT_SUBSCRIPTION_OVERRIDE_EMAIL } from '../config/server.config.js';
import logger from '../utils/logger.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    AttendanceReportResult,
    BillingReportResult,
    LeaveReportResult,
    UtilizationReportResult,
} from './report.service.js';
import type {
    CreateReportSubscriptionBody,
    ListReportSubscriptionsQuery,
    PatchReportSubscriptionBody,
} from '../validators/report-subscription.validator.js';

/**
 * Report-subscription service (Phase 4 Step 43).
 *
 * Two responsibilities:
 *  1. **Owner-scoped CRUD** — mirrors Step-42 preset patterns
 *     (per-user cap pre-check, `(user_id, name)` E11000 mapping,
 *     locked `report_name` on PATCH, anti-enumeration 404).
 *  2. **Daily 07:00 IST sweep** (`runWeeklyReportSweep`) — finds
 *     active subscriptions whose `day_of_week` matches today (IST)
 *     AND haven't been sent yet today, runs the matching report,
 *     renders the email, sends via the mailer, then stamps
 *     `last_sent_at` via atomic CAS.
 *
 * Reuses Step-42's `parsePresetFilters` for the per-report-name
 * filter dispatch — saved subscriptions can never store a filter
 * shape the corresponding `/reports/:name` would reject.
 */

// ─── Helpers ───────────────────────────────────────────────────────────

const toPublic = (doc: ReportSubscriptionDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

const wrapZodError = (err: unknown): never => {
    if (err instanceof z.ZodError) {
        const details = {
            errors: err.issues.map((issue) => ({
                field: ['filters', ...issue.path].join('.'),
                message: issue.message,
            })),
        };
        throw AppError.validation('Subscription filter validation failed', details);
    }
    throw err;
};

const validateFilters = (name: ReportExportName, filters: unknown): Record<string, unknown> => {
    try {
        return parsePresetFilters(name, filters);
    } catch (err) {
        return wrapZodError(err);
    }
};

// ─── Create ────────────────────────────────────────────────────────────

export const createSubscription = async (
    body: CreateReportSubscriptionBody,
    callerId: Types.ObjectId,
    audit: AuditContext | undefined
): Promise<Record<string, unknown>> => {
    const existingCount = await ReportSubscription.countDocuments({ user_id: callerId });
    if (existingCount >= REPORT_SUBSCRIPTION_PER_USER_CAP) {
        throw AppError.unprocessable(
            `Cannot save more than ${REPORT_SUBSCRIPTION_PER_USER_CAP} report subscriptions — delete one first`,
            ERROR_CODES.REPORT_SUBSCRIPTION_LIMIT_EXCEEDED
        );
    }

    const filters = validateFilters(body.report_name, body.filters);

    let doc: ReportSubscriptionDocument;
    try {
        doc = await ReportSubscription.create({
            user_id: callerId,
            name: body.name,
            report_name: body.report_name,
            filters,
            day_of_week: body.day_of_week,
            hour_local: body.hour_local,
            output_format: body.output_format,
            is_active: body.is_active,
        });
    } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
            throw AppError.conflict(
                `A subscription named "${body.name}" already exists; pick a different name`,
                ERROR_CODES.DUPLICATE_RESOURCE
            );
        }
        throw err;
    }

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.REPORT_SUBSCRIPTION_CREATE,
            target: { kind: AUDIT_TARGET_KINDS.REPORT_SUBSCRIPTION, id: doc._id },
            after: toPublic(doc),
            metadata: { report_name: body.report_name, day_of_week: body.day_of_week },
        });
    }
    return toPublic(doc);
};

// ─── List ──────────────────────────────────────────────────────────────

export const listSubscriptions = async (
    query: ListReportSubscriptionsQuery,
    callerId: Types.ObjectId
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = { user_id: callerId };
    if (query.report_name) filter.report_name = query.report_name;
    if (query.is_active !== undefined) filter.is_active = query.is_active;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        ReportSubscription.find(filter).sort({ name: 1 }).skip(skip).limit(query.limit),
        ReportSubscription.countDocuments(filter),
    ]);

    return {
        data: rows.map(toPublic),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── Get ───────────────────────────────────────────────────────────────

export const getSubscription = async (
    id: Types.ObjectId,
    callerId: Types.ObjectId
): Promise<Record<string, unknown>> => {
    const doc = await ReportSubscription.findOne({ _id: id, user_id: callerId });
    if (!doc) throw AppError.notFound('Report subscription not found', ERROR_CODES.REPORT_SUBSCRIPTION_NOT_FOUND);
    return toPublic(doc);
};

// ─── Patch ─────────────────────────────────────────────────────────────

export const updateSubscription = async (
    id: Types.ObjectId,
    body: PatchReportSubscriptionBody,
    callerId: Types.ObjectId,
    audit: AuditContext | undefined
): Promise<Record<string, unknown>> => {
    const doc = await ReportSubscription.findOne({ _id: id, user_id: callerId });
    if (!doc) throw AppError.notFound('Report subscription not found', ERROR_CODES.REPORT_SUBSCRIPTION_NOT_FOUND);

    const before = toPublic(doc);

    if (body.name !== undefined) doc.name = body.name;
    if (body.filters !== undefined) {
        // Lock `report_name` at creation — validate against the
        // existing row's report_name, NOT anything in the patch body.
        doc.filters = validateFilters(doc.report_name, body.filters);
    }
    if (body.day_of_week !== undefined) doc.day_of_week = body.day_of_week;
    if (body.hour_local !== undefined) doc.hour_local = body.hour_local;
    if (body.output_format !== undefined) doc.output_format = body.output_format;
    if (body.is_active !== undefined) doc.is_active = body.is_active;

    try {
        await doc.save();
    } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
            throw AppError.conflict(
                `A subscription named "${doc.name}" already exists; pick a different name`,
                ERROR_CODES.DUPLICATE_RESOURCE
            );
        }
        throw err;
    }

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.REPORT_SUBSCRIPTION_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.REPORT_SUBSCRIPTION, id: doc._id },
            before,
            after: toPublic(doc),
        });
    }

    return toPublic(doc);
};

// ─── Delete ────────────────────────────────────────────────────────────

export const deleteSubscription = async (
    id: Types.ObjectId,
    callerId: Types.ObjectId,
    audit: AuditContext | undefined
): Promise<{ deleted: true }> => {
    const doc = await ReportSubscription.findOne({ _id: id, user_id: callerId });
    if (!doc) throw AppError.notFound('Report subscription not found', ERROR_CODES.REPORT_SUBSCRIPTION_NOT_FOUND);

    const before = toPublic(doc);
    await doc.deleteOne();

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.REPORT_SUBSCRIPTION_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.REPORT_SUBSCRIPTION, id: doc._id },
            before,
        });
    }

    return { deleted: true };
};

// ─── Weekly sweep (cron entry point) ───────────────────────────────────

interface SweepSummary extends Record<string, unknown> {
    subscriptions_scanned: number;
    emails_sent: number;
    skipped_already_today: number;
    failures: number;
}

const buildReportForSubscription = async (
    name: ReportExportName,
    filters: Record<string, unknown>
): Promise<BillingReportResult | UtilizationReportResult | AttendanceReportResult | LeaveReportResult> => {
    // Filters were validated against the matching schema at create
    // time. They're stored as the parsed shape so the cast here is
    // safe at runtime as long as the schemas haven't drifted.
    switch (name) {
        case 'billing':
            return buildBillingReport(filters as never);
        case 'utilization':
            return buildUtilizationReport(filters as never);
        case 'attendance':
            return buildAttendanceReport(filters as never);
        case 'leaves':
            return buildLeaveReport(filters as never);
    }
};

const toTabularFor = (
    name: ReportExportName,
    result: BillingReportResult | UtilizationReportResult | AttendanceReportResult | LeaveReportResult
): TabularReport => {
    switch (name) {
        case 'billing':
            return toTabularBilling(result as BillingReportResult);
        case 'utilization':
            return toTabularUtilization(result as UtilizationReportResult);
        case 'attendance':
            return toTabularAttendance(result as AttendanceReportResult);
        case 'leaves':
            return toTabularLeaves(result as LeaveReportResult);
    }
};

/**
 * V2-BE-13 — generate the attachment buffer for the subscription's
 * configured `output_format` (csv/xlsx/pdf). Returns `null` to signal
 * a controlled fallback to `inline` HTML; the caller audit-logs the
 * fallback so operators can spot drift.
 *
 * Failure paths:
 *  - Generator threw (PDF engine crash, blank table, etc.) → null
 *  - Result exceeds `REPORT_SUBSCRIPTION_ATTACHMENT_MAX_BYTES` → null
 *
 * Either way, the recipient still gets data (the caller falls back).
 * The size cap is enforced HERE so we never thread a 50 MB Buffer
 * through the mailer / transport layer just to have the provider
 * reject it.
 */
interface AttachmentBuildSuccess {
    attachment: EmailAttachment;
    table: TabularReport;
}
interface AttachmentBuildFallback {
    attachment: null;
    table: TabularReport;
    fallback_reason: 'generation_failed' | 'attachment_too_large';
    error_message?: string;
    bytes?: number;
}
type AttachmentBuildResult = AttachmentBuildSuccess | AttachmentBuildFallback;

const buildAttachmentBuffer = async (
    format: Exclude<ReportSubscriptionOutputFormat, 'inline'>,
    table: TabularReport
): Promise<Buffer> => {
    switch (format) {
        case 'csv':
            return generateCsv(table);
        case 'xlsx':
            return await generateXlsx(table);
        case 'pdf':
            return await generatePdf(table);
    }
};

const buildSubscriptionAttachment = async (
    sub: ReportSubscriptionDocument,
    result: BillingReportResult | UtilizationReportResult | AttendanceReportResult | LeaveReportResult,
    todayIso: string
): Promise<AttachmentBuildResult> => {
    const table = toTabularFor(sub.report_name, result);
    const format = sub.output_format as Exclude<ReportSubscriptionOutputFormat, 'inline'>;

    let content: Buffer;
    try {
        content = await buildAttachmentBuffer(format, table);
    } catch (err) {
        return {
            attachment: null,
            table,
            fallback_reason: 'generation_failed',
            error_message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
        };
    }

    if (content.length > REPORT_SUBSCRIPTION_ATTACHMENT_MAX_BYTES) {
        return {
            attachment: null,
            table,
            fallback_reason: 'attachment_too_large',
            bytes: content.length,
        };
    }

    const { extension, mime } = EXPORT_FORMAT_CONFIG[format as ExportFormat];
    const filename = `${sub.name.replace(/[^\w-]+/g, '_').slice(0, 60) || 'report'}-${todayIso}.${extension}`;
    return {
        attachment: { filename, contentType: mime, content },
        table,
    };
};

/**
 * Daily 07:00 IST sweep. Idempotency:
 *  - Outer: `job_runs` unique index on `(name, run_key)`.
 *  - Inner: per-subscription `last_sent_at` stamp (CAS update).
 *
 * Per-subscription failure isolation: a failing send (mailer outage,
 * recipient deactivated, report builder threw) increments
 * `summary.failures` but doesn't abort the rest of the sweep.
 *
 * Recipient resolution: the subscription's owner is the recipient.
 * If the owner is deactivated since creating the subscription, the
 * send is skipped (no email to a deactivated user) and the row stays
 * unstamped for tomorrow's tick to retry — same self-healing posture
 * as Step-39 audit-archive.
 */
export const runWeeklyReportSweep = async (now: Date = new Date()): Promise<SweepSummary> => {
    const summary: SweepSummary = {
        subscriptions_scanned: 0,
        emails_sent: 0,
        skipped_already_today: 0,
        failures: 0,
    };

    const today = dayjs(now).tz(DEFAULT_TIMEZONE);
    const todayIso = today.format(DATE_FORMAT);
    const todayWeekday = today.day();

    const candidates = await ReportSubscription.find({
        is_active: true,
        day_of_week: todayWeekday,
    })
        .limit(REPORT_SUBSCRIPTION_MAX_PER_RUN)
        .exec();

    for (const sub of candidates) {
        summary.subscriptions_scanned += 1;
        if (sub.last_sent_at === todayIso) {
            summary.skipped_already_today += 1;
            continue;
        }

        try {
            // Resolve recipient — sub's owner.
            const owner = await User.findById(sub.user_id)
                .select('_id full_name email status')
                .lean<{ _id: Types.ObjectId; full_name: string; email: string; status: string } | null>();

            if (!owner || owner.status !== USER_STATUSES.ACTIVE) {
                logger.warn(
                    { subscription_id: sub._id.toString(), owner_id: sub.user_id.toString() },
                    'Skipping subscription send — owner missing or deactivated'
                );
                summary.failures += 1;
                continue;
            }

            const result = await buildReportForSubscription(sub.report_name, sub.filters as Record<string, unknown>);

            // V2-BE-13 — choose inline vs attachment based on the
            // subscription's `output_format`. On generation failure or
            // size-cap breach we fall back to inline + audit-log so the
            // recipient never gets nothing.
            let email: { subject: string; html: string; text: string };
            let attachments: EmailAttachment[] | undefined;
            let delivery_format: 'inline' | 'csv' | 'xlsx' | 'pdf' = 'inline';
            let fallback_audit: { reason: string; detail?: string } | null = null;

            if (sub.output_format === 'inline') {
                email = renderReportSubscriptionEmail(sub.report_name, result, sub.name);
            } else {
                const built = await buildSubscriptionAttachment(sub, result, todayIso);
                if (built.attachment) {
                    email = renderReportSubscriptionAttachmentNotice(
                        sub.report_name,
                        result,
                        sub.name,
                        built.attachment.filename
                    );
                    attachments = [built.attachment];
                    delivery_format = sub.output_format;
                } else {
                    // Controlled fallback — generate inline HTML so the
                    // user still gets the data; record what failed.
                    email = renderReportSubscriptionEmail(sub.report_name, result, sub.name);
                    fallback_audit = {
                        reason: built.fallback_reason,
                        detail:
                            built.fallback_reason === 'generation_failed'
                                ? built.error_message
                                : built.bytes !== undefined
                                  ? `${built.bytes} bytes (cap ${REPORT_SUBSCRIPTION_ATTACHMENT_MAX_BYTES})`
                                  : undefined,
                    };
                    logger.warn(
                        {
                            subscription_id: sub._id.toString(),
                            requested_format: sub.output_format,
                            fallback_reason: built.fallback_reason,
                            detail: fallback_audit.detail,
                        },
                        'Attachment build failed; falling back to inline HTML'
                    );
                }
            }

            // Recipient is normally the owner. A configured
            // REPORT_SUBSCRIPTION_OVERRIDE_EMAIL redirects delivery to a
            // single address (demo/testing) without touching the report
            // data or the audit target, both of which stay owner-scoped.
            const recipient = REPORT_SUBSCRIPTION_OVERRIDE_EMAIL ?? owner.email;
            if (REPORT_SUBSCRIPTION_OVERRIDE_EMAIL) {
                logger.info(
                    {
                        subscription_id: sub._id.toString(),
                        owner_email: owner.email,
                        override_to: REPORT_SUBSCRIPTION_OVERRIDE_EMAIL,
                    },
                    'Report-subscription delivery redirected via REPORT_SUBSCRIPTION_OVERRIDE_EMAIL'
                );
            }

            await sendEmail({
                to: recipient,
                subject: email.subject,
                html: email.html,
                text: email.text,
                context: 'report_subscription.send',
                attachments,
            });

            // Stamp atomically — defends against a concurrent tick
            // (test seam / accidental double schedule) firing the
            // same subscription twice.
            const stamp = await ReportSubscription.findOneAndUpdate(
                { _id: sub._id, last_sent_at: sub.last_sent_at },
                { $set: { last_sent_at: todayIso } },
                { new: true }
            );

            if (!stamp) {
                logger.warn(
                    { subscription_id: sub._id.toString() },
                    'Subscription stamp race lost — duplicate email was sent'
                );
                // The email has ALREADY gone out (sendEmail above
                // succeeded). Audit the duplicate so an admin
                // investigating "why did this user get two emails"
                // has a forensic trail showing what happened. The
                // ordering is intentional: send-then-stamp is more
                // tolerant of mailer outages (failed send → no stamp
                // → retry tomorrow) at the cost of duplicate-send
                // risk on the race; the audit makes the trade-off
                // visible to ops.
                // M24 — `recipient_email` removed; see the success path
                // above for the rationale (PII visible to
                // `AUDIT_LOG_READ`-only holders, resolvable via target).
                await recordSystemAudit({
                    action: AUDIT_ACTIONS.REPORT_SUBSCRIPTION_SEND,
                    target: { kind: AUDIT_TARGET_KINDS.REPORT_SUBSCRIPTION, id: sub._id },
                    metadata: {
                        report_name: sub.report_name,
                        fire_date: todayIso,
                        delivery: 'duplicate_sent',
                    },
                });
                summary.failures += 1;
                continue;
            }

            // M13 — `attachment_filename` + `size_bytes` were dropped from
            // the success path (failure / fallback already captured the
            // size in `fallback_detail`). Surface them on send so an ops
            // walk-back ("which report? how big?") doesn't need to
            // re-derive from the attachment build step.
            // M24 — `recipient_email` removed. The audit target already
            // carries `kind: REPORT_SUBSCRIPTION, id: sub._id` and the
            // subscription row has `owner_user_id`; an auditor with
            // `USER_READ` can resolve the email from there. Keeping it
            // here let `AUDIT_LOG_READ`-only holders pluck PII without
            // the user-read gate.
            const attachment = attachments?.[0];
            await recordSystemAudit({
                action: AUDIT_ACTIONS.REPORT_SUBSCRIPTION_SEND,
                target: { kind: AUDIT_TARGET_KINDS.REPORT_SUBSCRIPTION, id: sub._id },
                metadata: {
                    report_name: sub.report_name,
                    fire_date: todayIso,
                    delivery: 'sent',
                    requested_format: sub.output_format,
                    delivered_format: delivery_format,
                    ...(attachment
                        ? {
                              attachment_filename: attachment.filename,
                              size_bytes: attachment.content.length,
                          }
                        : {}),
                    ...(fallback_audit
                        ? {
                              fallback_reason: fallback_audit.reason,
                              fallback_detail: fallback_audit.detail ?? null,
                          }
                        : {}),
                },
            });

            summary.emails_sent += 1;
        } catch (err) {
            logger.warn(
                { err, subscription_id: sub._id.toString() },
                'Subscription send failed; will retry next matching tick'
            );
            // System audit the failure too — operators grep this for
            // delivery problems.
            try {
                await recordSystemAudit({
                    action: AUDIT_ACTIONS.REPORT_SUBSCRIPTION_SEND,
                    target: { kind: AUDIT_TARGET_KINDS.REPORT_SUBSCRIPTION, id: sub._id },
                    metadata: {
                        report_name: sub.report_name,
                        fire_date: todayIso,
                        delivery: 'failed',
                        error_message: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
                    },
                });
            } catch {
                // recordSystemAudit is non-throwing; this is paranoia.
            }
            summary.failures += 1;
        }
    }

    return summary;
};
