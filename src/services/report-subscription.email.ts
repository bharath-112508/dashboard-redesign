import { REPORT_SUBSCRIPTION_PREVIEW_ROW_LIMIT } from '../constants/report-subscription.js';
import { type ReportExportName } from '../constants/export.js';
import {
    toTabularAttendance,
    toTabularBilling,
    toTabularLeaves,
    toTabularUtilization,
    type TabularReport,
} from './report-exporters/tabular.js';
import type {
    AttendanceReportResult,
    BillingReportResult,
    LeaveReportResult,
    UtilizationReportResult,
} from './report.service.js';

/**
 * Pure email renderer for report-subscription deliveries
 * (Phase 4 Step 43).
 *
 * Reuses the Step-30 `tabular` adapter so the email summary stays
 * structurally aligned with the CSV/XLSX exports — same columns,
 * same labels, same totals. The email body shows:
 *   - A subject line with the report name + date range
 *   - The summary block (project / window / totals)
 *   - The first `REPORT_SUBSCRIPTION_PREVIEW_ROW_LIMIT` rows
 *   - "and N more" hint when truncated
 *
 * No attachments in v1 — the existing mailer is HTML-body-only;
 * attachment support would require ACS migration first
 * (Build_Decisions §D1).
 */

export interface RenderedEmail {
    subject: string;
    html: string;
    text: string;
}

const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const formatCell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) return '';
        return String(v);
    }
    return String(v);
};

const renderHtml = (table: TabularReport): { html: string; text: string } => {
    const rowsForDisplay = table.rows.slice(0, REPORT_SUBSCRIPTION_PREVIEW_ROW_LIMIT);
    const hiddenCount = Math.max(0, table.rows.length - rowsForDisplay.length);

    // Inline styles only — most email clients strip <style> blocks.
    const summaryRows = table.summary
        .map(
            (s) =>
                `<tr><td style="padding:4px 12px 4px 0;color:#555;"><b>${escapeHtml(s.label)}</b></td>` +
                `<td style="padding:4px 0;">${escapeHtml(s.value)}</td></tr>`
        )
        .join('');

    const headerCells = table.columns
        .map(
            (c) =>
                '<th style="padding:6px 8px;background:#f5f5f5;border-bottom:1px solid #ddd;' +
                `text-align:left;font-weight:600;">${escapeHtml(c.label)}</th>`
        )
        .join('');

    const dataRows = rowsForDisplay
        .map((row) => {
            const cells = table.columns
                .map(
                    (c) =>
                        '<td style="padding:6px 8px;border-bottom:1px solid #eee;">' +
                        `${escapeHtml(formatCell(row[c.key]))}</td>`
                )
                .join('');
            return `<tr>${cells}</tr>`;
        })
        .join('');

    const moreLine =
        hiddenCount > 0
            ? `<p style="color:#777;font-style:italic;margin-top:12px;">…and ${hiddenCount} more rows. ` +
              'Open the full report in the app for the complete view.</p>'
            : '';

    const html =
        "<div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;" +
        'color:#222;max-width:720px;">' +
        `<h2 style="margin:0 0 16px;">${escapeHtml(table.title)}</h2>` +
        (table.summary.length > 0
            ? `<table style="border-collapse:collapse;margin-bottom:16px;">${summaryRows}</table>`
            : '') +
        (table.rows.length > 0
            ? '<table style="border-collapse:collapse;width:100%;font-size:14px;">' +
              `<thead><tr>${headerCells}</tr></thead><tbody>${dataRows}</tbody></table>`
            : '<p style="color:#777;font-style:italic;">No rows in this window.</p>') +
        moreLine +
        '</div>';

    // Plain-text version for clients that strip HTML (some compliance
    // gateways, screen readers, low-end mobile mail). Lossy but
    // honest — same summary + the row count, without the table.
    const summaryText = table.summary.map((s) => `${s.label}: ${s.value}`).join('\n');
    const text =
        `${table.title}\n\n` +
        (summaryText ? `${summaryText}\n\n` : '') +
        `Rows in window: ${table.rows.length}` +
        (hiddenCount > 0
            ? `\n(showing the first ${REPORT_SUBSCRIPTION_PREVIEW_ROW_LIMIT} in the HTML version of this email)`
            : '');

    return { html, text };
};

/**
 * Render the subscription email for a given report kind + result.
 * Pure — easy to unit-test without mocking the mailer.
 */
export const renderReportSubscriptionEmail = (
    reportName: ReportExportName,
    reportResult: BillingReportResult | UtilizationReportResult | AttendanceReportResult | LeaveReportResult,
    subscriptionName: string
): RenderedEmail => {
    let table: TabularReport;
    switch (reportName) {
        case 'billing':
            table = toTabularBilling(reportResult as BillingReportResult);
            break;
        case 'utilization':
            table = toTabularUtilization(reportResult as UtilizationReportResult);
            break;
        case 'attendance':
            table = toTabularAttendance(reportResult as AttendanceReportResult);
            break;
        case 'leaves':
            table = toTabularLeaves(reportResult as LeaveReportResult);
            break;
    }

    const { html, text } = renderHtml(table);
    return {
        subject: `${subscriptionName} — ${table.title}`,
        html,
        text,
    };
};
