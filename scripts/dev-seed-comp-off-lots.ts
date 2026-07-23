/**
 * Dev-only: seed realistic comp-off LOTS into the demo DB so the comp-off
 * pages render every visual state — healthy active lots, an "expiring soon"
 * lot, an already-expired lot (with its `expired` history row), and a
 * partially-consumed lot (with its `consumed` history row + allocations).
 *
 * The demo seed doesn't accrue comp-off, so the comp-off screens read empty.
 * This paints a spread across three internal users:
 *   user #1 — the full gradient (healthy / expiring-soon / expired / partial)
 *   user #2 — a couple of healthy lots on a different project
 *   user #3 — left at zero (control, to show the empty state)
 *
 * Idempotent: it wipes each seeded user's existing ledger rows first (safe on
 * the demo DB — comp-off isn't accrued there) so a re-run doesn't collide with
 * the unique `(user_id, timesheet_billable, source_date)` accrual index.
 *
 * Uses the native driver so `created_at`/`updated_at` can be pinned to the
 * source dates for realism (Mongoose's timestamp plugin would overwrite them),
 * then calls the service's `recomputeBalance` to fix each user's cached
 * `users.comp_off_balance`. NOT for production.
 *
 *   npx tsx scripts/dev-seed-comp-off-lots.ts
 */
import mongoose, { Types } from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { COLLECTIONS } from '../src/constants/collections.js';
import { COMP_OFF_SOURCES, COMP_OFF_TYPES, COMP_OFF_EXPIRING_SOON_DAYS } from '../src/constants/leave.js';
import { recomputeBalance } from '../src/services/comp-off.service.js';

// Noon IST (06:30 UTC) on a date — same convention as the other demo scripts.
const at = (iso: string) => new Date(`${iso}T06:30:00.000Z`);

// `now`-relative expiry dates (scripts may read the wall clock).
const NOW = new Date();
const addDays = (base: Date, days: number) => new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
const endOfDay = (d: Date) => {
    const c = new Date(d);
    c.setUTCHours(23, 59, 59, 999);
    return c;
};

interface LotSpec {
    source_date: string; // ISO YYYY-MM-DD (also the per-day accrual key)
    source_minutes: number;
    days: number;
    remaining_days: number;
    expires_at: Date;
    expired: boolean;
}

interface SeededUser {
    _id: Types.ObjectId;
    full_name: string;
    role: string;
    lots: number;
    remaining: number;
    expiringSoon: number;
    expired: number;
}

const buildEarnedRow = (
    userId: Types.ObjectId,
    projectId: Types.ObjectId | null,
    projectName: string | null,
    spec: LotSpec
) => ({
    _id: new Types.ObjectId(),
    user_id: userId,
    type: COMP_OFF_TYPES.EARNED,
    days: spec.days,
    remaining_days: spec.remaining_days,
    expires_at: spec.expires_at,
    expired: spec.expired,
    source_type: COMP_OFF_SOURCES.TIMESHEET_BILLABLE,
    source_ref_id: null,
    project_id: projectId,
    project_name: projectName,
    source_minutes: spec.source_minutes,
    source_date: spec.source_date,
    allocations: [] as { lot_id: Types.ObjectId; days: number }[],
    reversed_at: null as Date | null,
    remarks: '',
    created_by: null,
    created_at: at(spec.source_date),
    updated_at: at(spec.source_date),
});

const main = async () => {
    await connectDB();
    const db = mongoose.connection.db!;
    const usersCol = db.collection(COLLECTIONS.USERS);
    const projectsCol = db.collection(COLLECTIONS.PROJECTS);
    const ledgerCol = db.collection(COLLECTIONS.COMP_OFF_LEDGER);

    // ── Pick 3 active INTERNAL users + up to 3 real projects for provenance ──
    const users = await usersCol
        .find({ role: { $in: ['employee', 'team_lead', 'manager'] }, status: 'active' })
        .project({ _id: 1, full_name: 1, role: 1 })
        .limit(3)
        .toArray();

    if (users.length < 3) {
        console.error(`Need 3 active internal users, found ${users.length}. Aborting.`);
        await disconnectDB();
        process.exit(1);
    }

    const projects = await projectsCol.find({}).project({ _id: 1, name: 1 }).limit(3).toArray();
    if (projects.length === 0) {
        console.error('No projects found — cannot attach provenance. Aborting.');
        await disconnectDB();
        process.exit(1);
    }
    const projA = projects[0]!;
    const projB = projects[1] ?? projects[0]!;

    const [u1, u2, u3] = users as [
        { _id: Types.ObjectId; full_name: string; role: string },
        { _id: Types.ObjectId; full_name: string; role: string },
        { _id: Types.ObjectId; full_name: string; role: string },
    ];

    // Idempotency: clear any existing ledger rows for the seeded users.
    const seededIds = [u1._id, u2._id, u3._id];
    const cleared = await ledgerCol.deleteMany({ user_id: { $in: seededIds } });
    console.log(`Cleared ${cleared.deletedCount ?? 0} existing ledger row(s) for the 3 seeded users.\n`);

    const rows: Record<string, unknown>[] = [];

    // ── User #1 — the full gradient ─────────────────────────────────────────
    // Lot A: healthy, expires in ~40 days.
    const lotA = buildEarnedRow(u1._id, projA._id as Types.ObjectId, projA.name as string, {
        source_date: '2026-07-10',
        source_minutes: 600, // 10h
        days: 1,
        remaining_days: 1,
        expires_at: endOfDay(addDays(NOW, 40)),
        expired: false,
    });
    // Lot B: EXPIRING SOON, expires in ~7 days.
    const lotB = buildEarnedRow(u1._id, projA._id as Types.ObjectId, projA.name as string, {
        source_date: '2026-07-05',
        source_minutes: 480, // 8h
        days: 0.5,
        remaining_days: 0.5,
        expires_at: endOfDay(addDays(NOW, 7)),
        expired: false,
    });
    // Lot C: ALREADY EXPIRED (expires_at in the past, remaining zeroed).
    const lotC = buildEarnedRow(u1._id, projA._id as Types.ObjectId, projA.name as string, {
        source_date: '2026-03-01',
        source_minutes: 720, // 12h
        days: 1,
        remaining_days: 0,
        expires_at: endOfDay(addDays(NOW, -10)),
        expired: true,
    });
    // Lot D: PARTIALLY CONSUMED (remaining < days).
    const lotD = buildEarnedRow(u1._id, projA._id as Types.ObjectId, projA.name as string, {
        source_date: '2026-06-20',
        source_minutes: 600, // 10h
        days: 1,
        remaining_days: 0.5,
        expires_at: endOfDay(addDays(NOW, 30)),
        expired: false,
    });

    // Matching `expired` history row for lot C (the lapsed 1 day).
    const expiredRowC = {
        _id: new Types.ObjectId(),
        user_id: u1._id,
        type: COMP_OFF_TYPES.EXPIRED,
        days: 1,
        remaining_days: 0,
        expires_at: null as Date | null,
        expired: false,
        source_type: COMP_OFF_SOURCES.TIMESHEET_BILLABLE,
        source_ref_id: lotC._id,
        project_id: projA._id as Types.ObjectId,
        project_name: projA.name as string,
        source_minutes: 0,
        // `null` (not the lot's date) so this history row stays OUT of the
        // partial-unique accrual index — the still-present earned lot already
        // holds the (user, timesheet_billable, source_date) slot.
        source_date: null as string | null,
        allocations: [] as { lot_id: Types.ObjectId; days: number }[],
        reversed_at: null as Date | null,
        remarks: 'Expired 1 unused comp-off day(s)',
        created_by: null,
        created_at: lotC.expires_at,
        updated_at: lotC.expires_at,
    };

    // Matching `consumed` history row for the 0.5 day drawn from lot D.
    const consumedRowD = {
        _id: new Types.ObjectId(),
        user_id: u1._id,
        type: COMP_OFF_TYPES.CONSUMED,
        days: 0.5,
        remaining_days: 0,
        expires_at: null as Date | null,
        expired: false,
        source_type: COMP_OFF_SOURCES.ADMIN_ADJUSTMENT,
        source_ref_id: null,
        project_id: null,
        project_name: null,
        source_minutes: 0,
        source_date: null,
        allocations: [{ lot_id: lotD._id, days: 0.5 }],
        reversed_at: null as Date | null,
        remarks: 'Half-day comp-off consumed',
        created_by: null,
        created_at: at('2026-07-01'),
        updated_at: at('2026-07-01'),
    };

    rows.push(lotA, lotB, lotC, lotD, expiredRowC, consumedRowD);

    // ── User #2 — a couple of healthy lots on a different project ────────────
    const u2LotA = buildEarnedRow(u2._id, projB._id as Types.ObjectId, projB.name as string, {
        source_date: '2026-07-12',
        source_minutes: 600, // 10h
        days: 1,
        remaining_days: 1,
        expires_at: endOfDay(addDays(NOW, 50)),
        expired: false,
    });
    const u2LotB = buildEarnedRow(u2._id, projB._id as Types.ObjectId, projB.name as string, {
        source_date: '2026-07-08',
        source_minutes: 480, // 8h
        days: 0.5,
        remaining_days: 0.5,
        expires_at: endOfDay(addDays(NOW, 45)),
        expired: false,
    });
    rows.push(u2LotA, u2LotB);

    // ── User #3 — control, no rows. ─────────────────────────────────────────

    await ledgerCol.insertMany(rows);
    console.log(`Inserted ${rows.length} ledger row(s).\n`);

    // ── Fix each seeded user's cached comp_off_balance from ledger truth. ────
    for (const u of seededIds) {
        await recomputeBalance(u);
    }

    // ── Summary ─────────────────────────────────────────────────────────────
    const soonCutoff = endOfDay(addDays(NOW, COMP_OFF_EXPIRING_SOON_DAYS));
    const summarize = async (u: { _id: Types.ObjectId; full_name: string; role: string }): Promise<SeededUser> => {
        const earned = await ledgerCol
            .find({ user_id: u._id, type: COMP_OFF_TYPES.EARNED })
            .toArray();
        const expiredRows = await ledgerCol
            .find({ user_id: u._id, type: COMP_OFF_TYPES.EXPIRED })
            .toArray();
        const remaining = earned
            .filter((r) => !r.expired)
            .reduce((a, r) => a + (r.remaining_days as number), 0);
        const expiringSoon = earned
            .filter(
                (r) =>
                    !r.expired &&
                    (r.remaining_days as number) > 0 &&
                    r.expires_at != null &&
                    (r.expires_at as Date) <= soonCutoff
            )
            .reduce((a, r) => a + (r.remaining_days as number), 0);
        const expired = expiredRows.reduce((a, r) => a + (r.days as number), 0);
        return {
            _id: u._id,
            full_name: u.full_name,
            role: u.role,
            lots: earned.length,
            remaining: Number(remaining.toFixed(2)),
            expiringSoon: Number(expiringSoon.toFixed(2)),
            expired: Number(expired.toFixed(2)),
        };
    };

    console.log('═══════════════════ SEED SUMMARY ═══════════════════');
    for (const u of [u1, u2, u3]) {
        const s = await summarize(u);
        console.log(`\n${s.full_name}  (${s.role})  id=${s._id.toString()}`);
        console.log(`  earned lots ......... ${s.lots}`);
        console.log(`  remaining days ...... ${s.remaining}`);
        console.log(`  expiring-soon days .. ${s.expiringSoon}  (within ${COMP_OFF_EXPIRING_SOON_DAYS} days)`);
        console.log(`  expired days ........ ${s.expired}`);
    }
    console.log('\n════════════════════════════════════════════════════');
    console.log(`Projects used for provenance: "${projA.name}"${projB._id !== projA._id ? ` and "${projB.name}"` : ''}`);

    await disconnectDB();
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
