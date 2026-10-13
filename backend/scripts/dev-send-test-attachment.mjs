#!/usr/bin/env node
/**
 * Dev-only: send a real email with an attachment to verify V2-BE-13
 * end-to-end against the configured email transport (ACS / Mailjet).
 *
 * Reuses the same code path the sweep uses — `sendEmail` from
 * `utils/mailer.ts` — so a successful delivery here means the sweep
 * will deliver too.
 *
 * Usage:
 *   node scripts/dev-send-test-attachment.mjs <recipient-email>
 *
 * Refuses to run in production.
 */
import 'dotenv/config';
process.env.NODE_ENV ??= 'development';
if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run in production.');
    process.exit(2);
}

const [, , recipient] = process.argv;
if (!recipient) {
    console.error('Usage: node scripts/dev-send-test-attachment.mjs <recipient-email>');
    process.exit(1);
}

const { default: mongoose } = await import('mongoose');
const { sendEmail } = await import('../src/utils/mailer.ts');
const { buildLeaveReport } = await import('../src/services/report.service.ts');
const { toTabularLeaves } = await import('../src/services/report-exporters/tabular.ts');
const { generateXlsx } = await import('../src/services/report-exporters/xlsx.ts');
const { renderReportSubscriptionAttachmentNotice } = await import(
    '../src/services/report-subscription.email.ts'
);

const uri = process.env.MONGO_URI;
if (!uri) {
    console.error('MONGO_URI not set.');
    process.exit(3);
}
await mongoose.connect(uri);
try {
    console.log('Building leave report for 2026…');
    const result = await buildLeaveReport({ year: 2026 });
    console.log(`  → ${result.balances?.length ?? 0} balance row(s) joined`);

    const table = toTabularLeaves(result);
    console.log(`  → tabular: ${table.rows.length} row(s), ${table.columns.length} column(s)`);

    console.log('Generating XLSX via exceljs…');
    const xlsxBuffer = await generateXlsx(table);
    console.log(`  → ${xlsxBuffer.length} bytes`);

    const filename = `viljetech-leaves-2026-${new Date().toISOString().slice(0, 10)}.xlsx`;
    const email = renderReportSubscriptionAttachmentNotice('leaves', result, 'Weekly leaves digest', filename);

    console.log(`Sending to ${recipient} via transport=${process.env.EMAIL_TRANSPORT}…`);
    await sendEmail({
        to: recipient,
        subject: email.subject + ' (dev test)',
        html: email.html,
        text: email.text,
        context: 'dev.report_subscription_attachment_test',
        attachments: [
            {
                filename,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                content: xlsxBuffer,
            },
        ],
    });
    console.log('✓ Sent. Check the inbox.');
} catch (err) {
    console.error('✗ Send failed:', err);
    process.exit(4);
} finally {
    await mongoose.disconnect();
}
