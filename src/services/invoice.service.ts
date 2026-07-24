import { Types, type ClientSession } from 'mongoose';

import { Engagement } from '../models/engagement.model.js';
import { Invoice, type InvoiceDocument, type InvoiceLineItem } from '../models/invoice.model.js';
import { Company } from '../models/company.model.js';
import { Project } from '../models/project.model.js';
import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import { BillingRate } from '../models/billing-rate.model.js';
import { nextInvoiceNumber } from './invoice-number.service.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { withTransaction } from '../utils/with-transaction.js';
import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from '../utils/date.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { GenerateInvoiceInput, UpdateInvoiceInput, ListInvoicesQuery } from '../validators/invoice.validator.js';

/**
 * Invoice service — Phase 1 "Client Engagements & Invoicing", Task 7 (the
 * core billing algorithm + the invoice lifecycle). Design spec §4
 * (generation) + §8 (integrity).
 *
 * Generation turns `engagement + [period_start, period_end]` into a
 * persisted, numbered **draft** invoice. The billable-hours component
 * **reuses the billing-report aggregation** (`report.service.ts` →
 * `buildBillingReport`) so an invoice's `hours` amounts equal what the
 * report would show for the same projects + window:
 *
 *   - `sumBillableByUser` matches `TimesheetEntry` on `project_id ∈ projectIds`,
 *     `local_date ∈ [from,to]`, `entry_type: 'task_linked'`, and sums
 *     `billable_total_minutes` grouped by `user_id` — identical `$match` to
 *     the report, grouped by user (the report's `group_by: 'employee'` shape).
 *   - The per-user bill rate is resolved from `BillingRate` the same way the
 *     report does: project-level rows (`task_id: null`) for the engagement's
 *     projects, effective at the window END (`effective_from <= to`,
 *     `effective_to` null or `>= to`), first-wins in `effective_from desc`
 *     order. No rate found → the line still lists the hours with `rate: null`,
 *     `amount: 0` (spec §8 — surfaced as a warning by the FE, never silently
 *     dropped). Since hours are grouped by user (task collapsed), only
 *     project-level rates apply — the same degradation the report makes for
 *     `group_by: 'employee'`.
 *
 * Money: every line `amount`, the `subtotal`, and `tax_amount` are rounded to
 * 2 decimals. `tax_amount = round(subtotal * tax_rate/100, 2)`;
 * `total = subtotal + tax_amount`.
 *
 * Multi-write generation runs inside `withTransaction`: the `Invoice.create`
 * and the setup-fee bill-once flag flip (`engagement.setup_fee_invoiced`)
 * commit together, and `nextInvoiceNumber` participates in the same session so
 * a rolled-back generate doesn't burn a sequence number's sibling writes.
 *
 * Audit: every mutation records a row via `recordAudit` (never throws).
 */

// ─── Caller shape ────────────────────────────────────────────────────────

export interface InvoiceActor {
    id: Types.ObjectId;
    audit?: AuditContext;
}

// ─── Money helpers ───────────────────────────────────────────────────────

/** Round to 2 decimal places, defeating binary-float drift (e.g. 1.005). */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const todayLocal = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

const yearOf = (isoDate: string): number => Number.parseInt(isoDate.slice(0, 4), 10);

const toPublic = (doc: InvoiceDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

// ─── Billable-hours aggregation (reused from the billing report) ─────────

export interface BillableByUserRow {
    user_id: Types.ObjectId;
    billable_minutes: number;
}

/**
 * Per-user billable minutes for a set of projects over `[from, to]`.
 * Identical `$match` semantics to `buildBillingReport`: `task_linked`
 * entries only, `local_date` window inclusive. Grouped by `user_id`
 * (the report's `group_by: 'employee'` shape). Exported for reuse/testing.
 */
export const sumBillableByUser = async ({
    projectIds,
    from,
    to,
}: {
    projectIds: Types.ObjectId[];
    from: string;
    to: string;
}): Promise<BillableByUserRow[]> => {
    if (projectIds.length === 0) return [];
    const rows = await TimesheetEntry.aggregate<{ _id: Types.ObjectId; billable_minutes: number }>([
        {
            $match: {
                project_id: { $in: projectIds },
                local_date: { $gte: from, $lte: to },
                entry_type: 'task_linked',
            },
        },
        {
            $group: {
                _id: '$user_id',
                billable_minutes: { $sum: '$billable_total_minutes' },
            },
        },
    ]);
    return rows.map((r) => ({ user_id: r._id, billable_minutes: r.billable_minutes }));
};

/**
 * Resolve the project-level bill rate per user, mirroring
 * `buildBillingReport`'s batched rate lookup: one `find` over all
 * `(user, project)` rate rows effective at the window end, first-wins in
 * `effective_from desc` order. Returns `user → rate` (missing = no rate).
 */
const resolveUserRates = async ({
    userIds,
    projectIds,
    to,
}: {
    userIds: Types.ObjectId[];
    projectIds: Types.ObjectId[];
    to: string;
}): Promise<Map<string, number>> => {
    const rateMap = new Map<string, number>();
    if (userIds.length === 0 || projectIds.length === 0) return rateMap;

    const rateRows = await BillingRate.find({
        user_id: { $in: userIds },
        project_id: { $in: projectIds },
        task_id: null, // project-level only (hours are grouped by user, task collapsed)
        effective_from: { $lte: to },
        $or: [{ effective_to: null }, { effective_to: { $gte: to } }],
    })
        .select('user_id hourly_rate effective_from')
        .sort({ effective_from: -1, _id: -1 })
        .lean<{ user_id: Types.ObjectId; hourly_rate: number; effective_from: string }[]>();

    for (const r of rateRows) {
        const key = r.user_id.toString();
        if (!rateMap.has(key)) rateMap.set(key, r.hourly_rate); // first (latest effective) wins
    }
    return rateMap;
};

// ─── Line builders ───────────────────────────────────────────────────────

const line = (
    partial: Partial<InvoiceLineItem> & { kind: InvoiceLineItem['kind']; description: string; amount: number }
): InvoiceLineItem => ({
    user_id: null,
    quantity_minutes: null,
    rate: null,
    ...partial,
});

interface HoursComputation {
    lines: InvoiceLineItem[];
    total_minutes: number;
    /** Σ per-user (minutes/60 × rate) over users that had a rate — the value pool. */
    total_value: number;
}

/**
 * One `hours` line per user with billable time, amount = round(hours × rate).
 * Also returns the aggregate minutes + value so the retainer-overage path can
 * reuse the same numbers (a retainer with `included_hours` bills the excess
 * of the SAME billable pool).
 */
const computeHours = async ({
    projectIds,
    from,
    to,
    kind,
}: {
    projectIds: Types.ObjectId[];
    from: string;
    to: string;
    kind: 'hours' | 'overage';
}): Promise<HoursComputation> => {
    const byUser = await sumBillableByUser({ projectIds, from, to });
    const userIds = byUser.map((r) => r.user_id);
    const rateMap = await resolveUserRates({ userIds, projectIds, to });

    let totalMinutes = 0;
    let totalValue = 0;
    const lines: InvoiceLineItem[] = byUser.map((r) => {
        const rate = rateMap.get(r.user_id.toString()) ?? null;
        const hours = r.billable_minutes / 60;
        const amount = rate !== null ? round2(hours * rate) : 0;
        totalMinutes += r.billable_minutes;
        totalValue += amount;
        return line({
            kind,
            description: `Billable hours (${(r.billable_minutes / 60).toFixed(2)}h)`,
            user_id: r.user_id,
            quantity_minutes: r.billable_minutes,
            rate,
            amount,
        });
    });

    return { lines, total_minutes: totalMinutes, total_value: round2(totalValue) };
};

// ─── POST /invoices/generate ─────────────────────────────────────────────

export const generateInvoice = async (
    input: GenerateInvoiceInput,
    actor: InvoiceActor
): Promise<Record<string, unknown>> => {
    const engagementId = new Types.ObjectId(input.engagement_id);
    const { period_start, period_end, confirm } = input;

    return withTransaction(async (session: ClientSession | undefined) => {
        const engagement = await Engagement.findById(engagementId);
        if (!engagement) throw AppError.notFound('Engagement not found', ERROR_CODES.ENGAGEMENT_NOT_FOUND);

        // 1) Resolve effective project scope — explicit list, or ALL of the
        //    company's projects when the engagement scope is empty.
        let projectIds: Types.ObjectId[] = engagement.project_ids ?? [];
        if (projectIds.length === 0) {
            const projects = await Project.find({ company_id: engagement.company_id })
                .select('_id')
                .lean<{ _id: Types.ObjectId }[]>();
            projectIds = projects.map((p) => p._id);
        }

        // 2) Overlap guard — a non-void invoice already covering this
        //    engagement + an overlapping period requires an explicit confirm.
        const overlap = await Invoice.findOne({
            engagement_id: engagementId,
            status: { $ne: 'void' },
            period_start: { $lte: period_end },
            period_end: { $gte: period_start },
        });
        if (overlap && !confirm) {
            throw AppError.conflict(
                'A non-void invoice already covers this engagement for an overlapping period',
                ERROR_CODES.INVOICE_PERIOD_OVERLAP,
                { existing_invoice_id: overlap._id.toString() }
            );
        }

        // 3) Build line items by component.
        const lineItems: InvoiceLineItem[] = [];
        const billingType = engagement.billing_type;

        // retainer (+ overage) — fires whenever a retainer amount is set.
        if (engagement.retainer_amount != null) {
            lineItems.push(
                line({
                    kind: 'retainer',
                    description: `Retainer${engagement.retainer_period ? ` (${engagement.retainer_period})` : ''}`,
                    amount: round2(engagement.retainer_amount),
                })
            );
            if (engagement.included_hours != null) {
                const hours = await computeHours({ projectIds, from: period_start, to: period_end, kind: 'overage' });
                const actualHours = hours.total_minutes / 60;
                if (actualHours > engagement.included_hours) {
                    const excessHours = actualHours - engagement.included_hours;
                    const excessMinutes = Math.round(excessHours * 60);
                    // Blended rate = value pool ÷ hours (single-user → that user's rate).
                    const blendedRate = hours.total_minutes > 0 ? hours.total_value / (hours.total_minutes / 60) : 0;
                    lineItems.push(
                        line({
                            kind: 'overage',
                            description: `Overage (${excessHours.toFixed(2)}h over ${engagement.included_hours}h included)`,
                            quantity_minutes: excessMinutes,
                            rate: round2(blendedRate),
                            amount: round2(excessHours * blendedRate),
                        })
                    );
                }
            }
        }

        // setup — one-time, bill-once via `setup_fee_invoiced` flipped in-txn.
        let flipSetup = false;
        if (engagement.setup_fee != null && engagement.setup_fee > 0 && !engagement.setup_fee_invoiced) {
            lineItems.push(line({ kind: 'setup', description: 'Setup fee', amount: round2(engagement.setup_fee) }));
            flipSetup = true;
        }

        // hourly — pure hourly + the hybrid hourly component. Hours are billed
        // EITHER as full hourly lines OR as overage on top of a retainer, never
        // both: when the engagement has a retainer component, hours are already
        // covered above (retainer + any overage over included_hours), so this
        // block must not also fire and double-bill the same hours.
        if ((billingType === 'hourly' || billingType === 'hybrid') && engagement.retainer_amount == null) {
            const hours = await computeHours({ projectIds, from: period_start, to: period_end, kind: 'hours' });
            lineItems.push(...hours.lines);
        }

        // fixed — a flat project fee (fixed + hybrid).
        if (engagement.fixed_amount != null) {
            lineItems.push(
                line({ kind: 'fixed', description: 'Fixed project fee', amount: round2(engagement.fixed_amount) })
            );
        }

        // 4) Totals. Tax defaults to 0 on generate (editable while draft).
        const subtotal = round2(lineItems.reduce((sum, l) => sum + l.amount, 0));
        const taxRate = 0;
        const taxAmount = round2((subtotal * taxRate) / 100);
        const total = round2(subtotal + taxAmount);

        // 5) Number + persist as draft (in-session).
        const number = await nextInvoiceNumber(yearOf(period_end), undefined, session);

        const [created] = await Invoice.create(
            [
                {
                    number,
                    company_id: engagement.company_id,
                    engagement_id: engagementId,
                    project_ids: projectIds,
                    period_start,
                    period_end,
                    currency: engagement.currency,
                    line_items: lineItems,
                    subtotal,
                    tax_rate: taxRate,
                    tax_label: 'No tax',
                    tax_amount: taxAmount,
                    total,
                    status: 'draft',
                    issue_date: null,
                    due_date: null,
                    paid_date: null,
                    notes: '',
                    created_by: actor.id,
                },
            ],
            session ? { session } : {}
        );

        // Flip the bill-once setup flag inside the same transaction.
        if (flipSetup) {
            engagement.setup_fee_invoiced = true;
            await engagement.save(session ? { session } : undefined);
        }

        if (actor.audit) {
            await recordAudit(actor.audit, {
                action: AUDIT_ACTIONS.INVOICE_GENERATE,
                target: { kind: AUDIT_TARGET_KINDS.INVOICE, id: created._id },
                after: toPublic(created),
                metadata: {
                    engagement_id: engagementId.toString(),
                    number,
                    period_start,
                    period_end,
                    line_count: lineItems.length,
                    total,
                },
            });
        }

        return toPublic(created);
    });
};

// ─── PATCH /invoices/:id ─────────────────────────────────────────────────

const loadOr404 = async (id: Types.ObjectId): Promise<InvoiceDocument> => {
    const invoice = await Invoice.findById(id);
    if (!invoice) throw AppError.notFound('Invoice not found', ERROR_CODES.INVOICE_NOT_FOUND);
    return invoice;
};

export const updateInvoice = async (
    id: Types.ObjectId,
    patch: UpdateInvoiceInput,
    actor: InvoiceActor
): Promise<Record<string, unknown>> => {
    const invoice = await loadOr404(id);
    if (invoice.status !== 'draft') {
        throw AppError.conflict('Only draft invoices can be edited', ERROR_CODES.INVOICE_NOT_DRAFT);
    }
    const before = toPublic(invoice);

    if (patch.line_items !== undefined) {
        const mapped = patch.line_items.map((l) =>
            line({
                kind: l.kind,
                description: l.description,
                user_id: l.user_id != null ? new Types.ObjectId(l.user_id) : null,
                quantity_minutes: l.quantity_minutes ?? null,
                rate: l.rate ?? null,
                amount: round2(l.amount),
            })
        );
        // Direct path assignment casts through the schema in Mongoose and is a
        // plain array assignment against the test mock — both expose `.reduce`.
        invoice.line_items = mapped as unknown as typeof invoice.line_items;
    }
    if (patch.tax_rate !== undefined) invoice.tax_rate = patch.tax_rate;
    if (patch.tax_label !== undefined) invoice.tax_label = patch.tax_label;
    if (patch.due_date !== undefined) invoice.due_date = patch.due_date;
    if (patch.notes !== undefined) invoice.notes = patch.notes;

    // Recompute totals from the (possibly replaced) lines + current tax rate.
    const subtotal = round2(invoice.line_items.reduce((sum, l) => sum + l.amount, 0));
    invoice.subtotal = subtotal;
    invoice.tax_amount = round2((subtotal * invoice.tax_rate) / 100);
    invoice.total = round2(subtotal + invoice.tax_amount);

    await invoice.save();

    if (actor.audit) {
        await recordAudit(actor.audit, {
            action: AUDIT_ACTIONS.INVOICE_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.INVOICE, id: invoice._id },
            before,
            after: toPublic(invoice),
        });
    }

    return toPublic(invoice);
};

// ─── POST /invoices/:id/status ───────────────────────────────────────────

type InvoiceStatusTo = 'sent' | 'paid' | 'void';

const isLegalTransition = (from: string, to: InvoiceStatusTo): boolean => {
    if (to === 'void') return from !== 'void'; // any non-void → void
    if (to === 'sent') return from === 'draft';
    if (to === 'paid') return from === 'sent';
    return false;
};

export const setInvoiceStatus = async (
    id: Types.ObjectId,
    to: InvoiceStatusTo,
    extra: { paid_date?: string },
    actor: InvoiceActor
): Promise<Record<string, unknown>> => {
    const invoice = await loadOr404(id);
    const from = invoice.status;

    if (!isLegalTransition(from, to)) {
        throw AppError.conflict(
            `Illegal invoice status transition ${from} → ${to}`,
            ERROR_CODES.INVOICE_INVALID_TRANSITION,
            { from, to }
        );
    }

    const before = toPublic(invoice);
    invoice.status = to;
    if (to === 'sent') invoice.issue_date = invoice.issue_date ?? todayLocal();
    if (to === 'paid') invoice.paid_date = extra.paid_date ?? todayLocal();

    await invoice.save();

    if (actor.audit) {
        await recordAudit(actor.audit, {
            action: AUDIT_ACTIONS.INVOICE_STATUS,
            target: { kind: AUDIT_TARGET_KINDS.INVOICE, id: invoice._id },
            before,
            after: toPublic(invoice),
            metadata: { from, to },
        });
    }

    return toPublic(invoice);
};

// ─── DELETE /invoices/:id ────────────────────────────────────────────────

export const deleteInvoice = async (id: Types.ObjectId, actor: InvoiceActor): Promise<void> => {
    const invoice = await loadOr404(id);
    if (invoice.status !== 'draft') {
        throw AppError.conflict(
            'Only draft invoices can be deleted; void sent/paid instead',
            ERROR_CODES.INVOICE_NOT_DRAFT
        );
    }
    const before = toPublic(invoice);
    await invoice.deleteOne();

    if (actor.audit) {
        await recordAudit(actor.audit, {
            action: AUDIT_ACTIONS.INVOICE_DELETE,
            target: { kind: AUDIT_TARGET_KINDS.INVOICE, id: invoice._id },
            before,
            metadata: { number: invoice.number },
        });
    }
};

// ─── GET /invoices/:id ───────────────────────────────────────────────────

export const getInvoice = async (id: Types.ObjectId): Promise<Record<string, unknown>> => {
    const invoice = await loadOr404(id);
    const obj = toPublic(invoice);

    const [company, engagement] = await Promise.all([
        Company.findById(invoice.company_id).select('_id name').lean<{ _id: Types.ObjectId; name: string } | null>(),
        Engagement.findById(invoice.engagement_id)
            .select('_id name')
            .lean<{ _id: Types.ObjectId; name: string } | null>(),
    ]);

    obj.company = company
        ? { id: company._id.toString(), name: company.name }
        : { id: invoice.company_id.toString(), name: null };
    obj.engagement = engagement
        ? { id: engagement._id.toString(), name: engagement.name }
        : { id: invoice.engagement_id.toString(), name: null };

    return obj;
};

// ─── GET /invoices ───────────────────────────────────────────────────────

export const listInvoices = async (
    query: ListInvoicesQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = {};
    if (query.company_id) filter.company_id = new Types.ObjectId(query.company_id);
    if (query.engagement_id) filter.engagement_id = new Types.ObjectId(query.engagement_id);
    if (query.status) filter.status = query.status;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        Invoice.find(filter).sort({ created_at: -1, _id: -1 }).skip(skip).limit(query.limit),
        Invoice.countDocuments(filter),
    ]);

    const companyIds = Array.from(new Set(rows.map((r) => r.company_id.toString()))).map(
        (id) => new Types.ObjectId(id)
    );
    const engagementIds = Array.from(new Set(rows.map((r) => r.engagement_id.toString()))).map(
        (id) => new Types.ObjectId(id)
    );

    const [companies, engagements] = await Promise.all([
        companyIds.length
            ? Company.find({ _id: { $in: companyIds } })
                  .select('_id name')
                  .lean<{ _id: Types.ObjectId; name: string }[]>()
            : Promise.resolve([]),
        engagementIds.length
            ? Engagement.find({ _id: { $in: engagementIds } })
                  .select('_id name')
                  .lean<{ _id: Types.ObjectId; name: string }[]>()
            : Promise.resolve([]),
    ]);

    const companyMap = new Map(companies.map((c) => [c._id.toString(), c.name]));
    const engagementMap = new Map(engagements.map((e) => [e._id.toString(), e.name]));

    return {
        data: rows.map((r) => {
            const obj = toPublic(r);
            obj.company = { id: r.company_id.toString(), name: companyMap.get(r.company_id.toString()) ?? null };
            obj.engagement = {
                id: r.engagement_id.toString(),
                name: engagementMap.get(r.engagement_id.toString()) ?? null,
            };
            return obj;
        }),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};
