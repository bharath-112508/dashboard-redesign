/**
 * Migration — backfill lot data onto legacy EARNED comp-off ledger rows.
 *
 * Context: the comp-off "lot" system adds `remaining_days` / `expires_at` /
 * `expired` to every earned row so the balance can be computed as
 * `Σ remaining_days` over non-expired lots and lapsed days can expire on a
 * 3-month window. Rows created before the lot fields existed carry neither an
 * `expires_at` nor a live `remaining_days`, so they'd read as fully consumed
 * (balance 0) and never expire. This script backfills them.
 *
 * DRY-RUN BY DEFAULT. Prints the plan and writes nothing. Pass `--commit`.
 *
 *   npx tsx scripts/migrate-comp-off-lots.ts             # plan only
 *   npx tsx scripts/migrate-comp-off-lots.ts --commit    # apply
 *
 * What it does — for every EARNED row missing lot data (detected via
 * `expires_at: null`, which the native driver matches for both explicit-null
 * AND absent fields):
 *   • `remaining_days = days`   (treat the whole legacy lot as still live)
 *   • `expires_at = created_at + COMP_OFF_EXPIRY_MONTHS months` (IST end-of-day)
 *   • `expired = false`
 *
 * What it deliberately does NOT do: reconcile legacy CONSUMPTION. Old comp-off
 * spends never wrote `consumed` ledger rows, so there is no durable record of
 * how much of each legacy lot was already used. Backfilling `remaining_days =
 * days` therefore OVER-credits any lot that was partially consumed under the
 * old model — that's a known, accepted trade-off (the alternative is stranding
 * every legacy lot at 0). The user-facing balance is only corrected on the
 * next `comp_off_reconciliation` cron run, which recomputes
 * `User.comp_off_balance = Σ remaining_days`. RUN THAT CRON (or trigger it)
 * after this migration — this script does not touch `User.comp_off_balance`.
 *
 * Native driver (`mongoose.connection.db`) — mirrors
 * scripts/dev-spread-demo-completions.ts so Mongoose's timestamp plugin
 * doesn't rewrite `updated_at` on the backfilled rows.
 *
 * Re-runnable: once a row has a non-null `expires_at` it no longer matches the
 * filter, so a second run is a clean no-op.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { COLLECTIONS } from '../src/constants/collections.js';
import { COMP_OFF_EXPIRY_MONTHS, COMP_OFF_TYPES } from '../src/constants/leave.js';
import dayjs, { DEFAULT_TIMEZONE } from '../src/utils/date.js';

const COMMIT = process.argv.includes('--commit');

interface LegacyLot {
    _id: mongoose.Types.ObjectId;
    user_id: mongoose.Types.ObjectId;
    days: number;
    created_at: Date;
}

/** created_at + COMP_OFF_EXPIRY_MONTHS, IST end-of-day (mirrors compOffExpiryFrom). */
const expiryFromCreatedAt = (createdAt: Date): Date =>
    dayjs(createdAt).tz(DEFAULT_TIMEZONE).add(COMP_OFF_EXPIRY_MONTHS, 'month').endOf('day').toDate();

const log = (...args: unknown[]): void => console.log(...args);

const run = async (): Promise<void> => {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error('No database handle');

    const ledger = db.collection(COLLECTIONS.COMP_OFF_LEDGER);

    log(`\n${'='.repeat(72)}`);
    log(
        COMMIT
            ? '  COMP-OFF LOT BACKFILL — COMMIT MODE (writes will be applied)'
            : '  COMP-OFF LOT BACKFILL — DRY RUN (no writes)'
    );
    log('='.repeat(72));

    // `{ expires_at: null }` matches both explicit-null AND absent fields in
    // MongoDB, so this catches pre-lot rows regardless of how they were saved.
    const filter = { type: COMP_OFF_TYPES.EARNED, expires_at: null };

    const rows = (await ledger
        .find(filter)
        .project({ _id: 1, user_id: 1, days: 1, created_at: 1 })
        .sort({ created_at: 1 })
        .toArray()) as unknown as LegacyLot[];

    log(`\n[1] ${rows.length} EARNED lot(s) missing lot data (expires_at: null).`);

    if (rows.length === 0) {
        log('\n  Nothing to backfill — every earned lot already carries expiry data.');
        log(`\n${'='.repeat(72)}`);
        log(COMMIT ? '  Done — no rows matched.' : '  DRY RUN — nothing to do.');
        log('='.repeat(72));
        await disconnectDB();
        return;
    }

    // Plan preview — sample the first few so the operator can eyeball the
    // computed expiry dates before committing.
    const SAMPLE = 10;
    let totalDays = 0;
    const perUser = new Map<string, number>();
    log('\n[2] Planned backfill (sample):');
    rows.forEach((r, i) => {
        totalDays += r.days;
        perUser.set(String(r.user_id), (perUser.get(String(r.user_id)) ?? 0) + r.days);
        if (i < SAMPLE) {
            const created = dayjs(r.created_at).tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD');
            const exp = dayjs(expiryFromCreatedAt(r.created_at)).tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD');
            log(
                `     • lot ${r._id} — ${r.days} day(s), created ${created} → remaining_days=${r.days}, expires_at=${exp}`
            );
        }
    });
    if (rows.length > SAMPLE) log(`     … and ${rows.length - SAMPLE} more.`);

    log('\n[3] Summary:');
    log(`     lots to backfill:     ${rows.length}`);
    log(`     users affected:       ${perUser.size}`);
    log(`     total days credited:  ${Number(totalDays.toFixed(2))}`);

    if (!COMMIT) {
        log(`\n${'='.repeat(72)}`);
        log('  DRY RUN — nothing written. Re-run with --commit to apply.');
        log('  AFTER committing, run the `comp_off_reconciliation` cron so each');
        log('  affected User.comp_off_balance is recomputed to Σ remaining_days.');
        log('='.repeat(72));
        await disconnectDB();
        return;
    }

    // ── COMMIT ───────────────────────────────────────────────────────────
    log(`\n${'='.repeat(72)}`);
    log('  APPLYING');
    log('='.repeat(72));

    let updated = 0;
    for (const r of rows) {
        const res = await ledger.updateOne(
            { _id: r._id, expires_at: null },
            {
                $set: {
                    remaining_days: r.days,
                    expires_at: expiryFromCreatedAt(r.created_at),
                    expired: false,
                },
            }
        );
        updated += res.modifiedCount;
    }

    log(`\n  ~ backfilled ${updated} earned lot(s).`);
    log('\n  Done.');
    log('  NOTE: legacy comp-off CONSUMPTION was never written as `consumed`');
    log('  ledger rows, so partially-used legacy lots are now over-credited.');
    log('  RUN THE `comp_off_reconciliation` cron next — it recomputes each');
    log('  User.comp_off_balance = Σ remaining_days over non-expired lots.');
    await disconnectDB();
};

run().catch(async (err) => {
    console.error(err);
    await disconnectDB().catch(() => {});
    process.exit(1);
});
