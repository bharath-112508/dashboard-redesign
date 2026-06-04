#!/usr/bin/env node
/**
 * Dev-only: fire the report-subscription sweep on demand without
 * waiting for the 07:00 IST cron. Lets us smoke V2-BE-13 end-to-end
 * — pick a day_of_week + IST timestamp that matches at least one
 * active subscription, run the sweep, and tail the dev logs to see
 * "DEV: email (transport=stub)" with the attachment list.
 *
 * Usage:
 *   node scripts/dev-fire-report-sweep.mjs
 *
 * Refuses to run in production.
 */
import 'dotenv/config';
process.env.NODE_ENV ??= 'development';
if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run in production.');
    process.exit(2);
}

// Lazy-load the compiled service. tsx handles the .ts import.
const { runWeeklyReportSweep } = await import('../src/services/report-subscription.service.ts');
const { default: mongoose } = await import('mongoose');

const uri = process.env.MONGO_URI;
if (!uri) {
    console.error('MONGO_URI not set.');
    process.exit(3);
}
await mongoose.connect(uri);
try {
    // Force a Monday-IST timestamp so a subscription with day_of_week=1 fires.
    // 2026-06-08 is a Monday in IST.
    const summary = await runWeeklyReportSweep(new Date('2026-06-08T07:00:00+05:30'));
    console.log('Sweep summary:', JSON.stringify(summary, null, 2));
} finally {
    await mongoose.disconnect();
}
