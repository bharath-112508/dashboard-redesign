import { Types } from 'mongoose';

import { Project } from '../models/project.model.js';
import { Engagement } from '../models/engagement.model.js';
import { User } from '../models/user.model.js';
import { sumBillableByUser, resolveUserRates } from './invoice.service.js';
import { resolveCostRateForUser } from './cost-rate.service.js';
import { getOrInitSettings } from './settings.service.js';
import { toReportingCurrency } from '../utils/fx.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';

/**
 * Margin report service — Billing Phase 2 "Cost Rates & Margin" (Task 4).
 * Design spec §Margin computation + §Output shape
 * (`docs/superpowers/specs/2026-07-24-cost-margin-design.md`).
 *
 * The PSA equation, per project, per user:
 *
 *   revenue_native = (billable_minutes / 60) × bill_rate   (project's engagement currency)
 *   cost_native    = (billable_minutes / 60) × cost_rate   (cost rate's own currency)
 *   revenue, cost  = both converted to `settings.billing.reporting_currency` via FX
 *   margin         = revenue − cost
 *
 * Deliberately reuses the Phase-1 money-path building blocks instead of
 * re-querying:
 *   - `sumBillableByUser` (invoice.service.ts) — identical `$match` to the
 *     billing report, grouped by user.
 *   - `resolveUserRates` (invoice.service.ts, exported for this file) — the
 *     project-level `BillingRate` resolution at the window end, first-wins
 *     latest `effective_from`. Keeping ONE source here preserves parity
 *     between invoices, the billing report, and margin.
 *   - `resolveCostRateForUser` (cost-rate.service.ts) — the cost-rate-at-date
 *     lookup (Task 3).
 *   - `toReportingCurrency` (utils/fx.ts) — throws `AppError` /
 *     `FX_RATE_MISSING` on an unconfigured rate; caught here and turned into
 *     a warning rather than a crash.
 *
 * Project → currency resolution: a project's revenue currency is the
 * currency of an ACTIVE engagement covering it — either one that lists the
 * project explicitly in `project_ids`, or a company-wide engagement
 * (`project_ids: []`) for the project's `company_id`. Explicit wins over
 * company-wide when both exist. No covering engagement → the project
 * defaults to the reporting currency (documented spec decision: a project
 * with no engagement has no client-currency context). When more than one
 * active engagement could apply, the most recently started one wins
 * (`start_date desc`, `_id desc` tiebreak) — deterministic, not "first in
 * Mongo's natural order".
 *
 * Rounding: money (revenue/cost/margin) to 2dp; `margin_pct` — a bare ratio
 * `margin / revenue`, NOT a percentage (per spec) — to 4dp, `null` when
 * revenue is 0 (can't divide). Warnings (missing bill rate / missing cost
 * rate / missing FX rate) are collected in a `Set` so the same "No FX rate
 * for NOK" doesn't repeat once per user.
 */

// ─── Result types (per spec §Output shape) ────────────────────────────────

export interface MarginUserRow {
    user: { id: string; full_name: string };
    billable_minutes: number;
    revenue: number;
    cost: number;
    margin: number;
}

export interface MarginProjectRow {
    project: { id: string; name: string };
    revenue: number;
    cost: number;
    margin: number;
    margin_pct: number | null;
    users: MarginUserRow[];
}

export interface MarginTotals {
    revenue: number;
    cost: number;
    margin: number;
    margin_pct: number | null;
}

export interface MarginReportResult {
    reporting_currency: string;
    from_date: string;
    to_date: string;
    rows: MarginProjectRow[];
    totals: MarginTotals;
    warnings: string[];
}

// ─── Money helpers ─────────────────────────────────────────────────────────

/** Round to 2 decimal places, defeating binary-float drift (e.g. 1.005). */
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** `margin_pct` is a bare ratio (not ×100) — round to 4dp for a stable 2dp-as-percent display. */
const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000;

const toObjectId = (id: Types.ObjectId | string): Types.ObjectId =>
    id instanceof Types.ObjectId ? id : new Types.ObjectId(id);

/** Convert `amount`, folding a thrown `FX_RATE_MISSING` into a warning + a zero contribution. */
const convertOrWarn = (
    amount: number,
    fromCurrency: string,
    reportingCurrency: string,
    fxRates: { currency: string; rate_to_base: number }[],
    warnings: Set<string>
): number => {
    try {
        return toReportingCurrency(amount, fromCurrency, reportingCurrency, fxRates);
    } catch (err) {
        if (err instanceof AppError && err.code === ERROR_CODES.FX_RATE_MISSING) {
            warnings.add(`No FX rate for ${fromCurrency.toUpperCase()}`);
            return 0;
        }
        throw err;
    }
};

// ─── buildMarginReport ──────────────────────────────────────────────────────

export const buildMarginReport = async (params: {
    from_date: string;
    to_date: string;
    project_id?: Types.ObjectId | string;
    company_id?: Types.ObjectId | string;
}): Promise<MarginReportResult> => {
    const { from_date, to_date } = params;

    const settings = await getOrInitSettings();
    const reporting_currency = settings.billing.reporting_currency;
    const fx_rates = settings.billing.fx_rates;

    // ── 1. Resolve projects in scope ────────────────────────────────────
    const projectFilter: Record<string, unknown> = {};
    if (params.project_id) {
        projectFilter._id = toObjectId(params.project_id);
    } else if (params.company_id) {
        projectFilter.company_id = toObjectId(params.company_id);
    }

    const projects = await Project.find(projectFilter)
        .select('name company_id')
        .lean<{ _id: Types.ObjectId; name: string; company_id: Types.ObjectId | null }[]>();

    const warnings = new Set<string>();

    if (projects.length === 0) {
        return {
            reporting_currency,
            from_date,
            to_date,
            rows: [],
            totals: { revenue: 0, cost: 0, margin: 0, margin_pct: null },
            warnings: [],
        };
    }

    // ── 2. Project → currency resolution via active engagements ────────
    const companyIds = Array.from(
        new Set(projects.filter((p) => p.company_id !== null).map((p) => (p.company_id as Types.ObjectId).toString()))
    ).map((id) => new Types.ObjectId(id));

    const engagements =
        companyIds.length === 0
            ? []
            : await Engagement.find({ status: 'active', company_id: { $in: companyIds } })
                  .select('company_id project_ids currency start_date')
                  .sort({ start_date: -1, _id: -1 })
                  .lean<
                      {
                          company_id: Types.ObjectId;
                          project_ids: Types.ObjectId[];
                          currency: string;
                          start_date: string;
                      }[]
                  >();

    const explicitProjectCurrency = new Map<string, string>();
    const companyWideCurrency = new Map<string, string>();
    for (const eng of engagements) {
        if (eng.project_ids.length > 0) {
            for (const pid of eng.project_ids) {
                const key = pid.toString();
                if (!explicitProjectCurrency.has(key)) explicitProjectCurrency.set(key, eng.currency);
            }
        } else {
            const key = eng.company_id.toString();
            if (!companyWideCurrency.has(key)) companyWideCurrency.set(key, eng.currency);
        }
    }

    const resolveProjectCurrency = (p: { _id: Types.ObjectId; company_id: Types.ObjectId | null }): string =>
        explicitProjectCurrency.get(p._id.toString()) ??
        (p.company_id ? companyWideCurrency.get(p.company_id.toString()) : undefined) ??
        reporting_currency;

    // ── 3. Per-project billable minutes + bill rates ────────────────────
    interface ProjectWork {
        id: Types.ObjectId;
        name: string;
        currency: string;
        byUser: { user_id: Types.ObjectId; billable_minutes: number }[];
        billRates: Map<string, number>;
    }

    const projectWork: ProjectWork[] = await Promise.all(
        projects.map(async (p) => {
            const byUser = await sumBillableByUser({ projectIds: [p._id], from: from_date, to: to_date });
            const userIds = byUser.map((r) => r.user_id);
            const billRates = await resolveUserRates({ userIds, projectIds: [p._id], to: to_date });
            return { id: p._id, name: p.name, currency: resolveProjectCurrency(p), byUser, billRates };
        })
    );

    // ── 4. Batch-load user display names once (no N+1) ──────────────────
    const allUserIds = Array.from(new Set(projectWork.flatMap((pw) => pw.byUser.map((r) => r.user_id.toString())))).map(
        (id) => new Types.ObjectId(id)
    );

    const users = allUserIds.length
        ? await User.find({ _id: { $in: allUserIds } })
              .select('full_name')
              .lean<{ _id: Types.ObjectId; full_name: string }[]>()
        : [];
    const userNames = new Map(users.map((u) => [u._id.toString(), u.full_name]));

    // ── 5. Per-user revenue/cost/margin, converted + rounded ────────────
    const rows: MarginProjectRow[] = await Promise.all(
        projectWork.map(async (pw) => {
            const userRows: MarginUserRow[] = await Promise.all(
                pw.byUser.map(async (r) => {
                    const userIdStr = r.user_id.toString();
                    const fullName = userNames.get(userIdStr) ?? userIdStr;
                    const hours = r.billable_minutes / 60;

                    const billRate = pw.billRates.get(userIdStr);
                    let revenueNative = 0;
                    if (billRate === undefined) {
                        warnings.add(`No bill rate for ${fullName}`);
                    } else {
                        revenueNative = hours * billRate;
                    }

                    const costRate = await resolveCostRateForUser(r.user_id, to_date);
                    let costNative = 0;
                    let costCurrency = reporting_currency;
                    if (!costRate) {
                        warnings.add(`No cost rate for ${fullName}`);
                    } else {
                        costNative = hours * costRate.cost_per_hour;
                        costCurrency = costRate.currency;
                    }

                    const revenue = round2(
                        convertOrWarn(revenueNative, pw.currency, reporting_currency, fx_rates, warnings)
                    );
                    const cost = round2(
                        convertOrWarn(costNative, costCurrency, reporting_currency, fx_rates, warnings)
                    );

                    return {
                        user: { id: userIdStr, full_name: fullName },
                        billable_minutes: r.billable_minutes,
                        revenue,
                        cost,
                        margin: round2(revenue - cost),
                    };
                })
            );

            const projectRevenue = round2(userRows.reduce((sum, u) => sum + u.revenue, 0));
            const projectCost = round2(userRows.reduce((sum, u) => sum + u.cost, 0));
            const projectMargin = round2(projectRevenue - projectCost);

            return {
                project: { id: pw.id.toString(), name: pw.name },
                revenue: projectRevenue,
                cost: projectCost,
                margin: projectMargin,
                margin_pct: projectRevenue > 0 ? round4(projectMargin / projectRevenue) : null,
                users: userRows,
            };
        })
    );

    // ── 6. Grand totals ───────────────────────────────────────────────
    const totalsRevenue = round2(rows.reduce((sum, r) => sum + r.revenue, 0));
    const totalsCost = round2(rows.reduce((sum, r) => sum + r.cost, 0));
    const totalsMargin = round2(totalsRevenue - totalsCost);

    return {
        reporting_currency,
        from_date,
        to_date,
        rows,
        totals: {
            revenue: totalsRevenue,
            cost: totalsCost,
            margin: totalsMargin,
            margin_pct: totalsRevenue > 0 ? round4(totalsMargin / totalsRevenue) : null,
        },
        warnings: Array.from(warnings),
    };
};
