/**
 * DEMO "today" seeder — makes TODAY (IST) look live for a demo:
 *   1. Attendance   — most internal staff checked in (on-time + a couple late),
 *                     a few not checked in. Backdated morning punch times so
 *                     they don't read as "just now / late". (direct Mongo)
 *   2. Timesheets   — 1–2 entries dated today per checked-in user (task-linked
 *                     for engineers, general for managers). (API, as each user)
 *   3. Leave        — one same-day Sick Leave applied + approved for today, so
 *                     the on-leave count / leave-mix is non-empty. (API)
 *   4. Comp-off     — one earned grant recorded today. (API)
 *
 * Targets whatever DB the BE `.env` MONGO_URI points at AND whatever DB the
 * running :3001 server is on — keep both on `vilje-platform-demo` for demos.
 *
 * Idempotent — safe to re-run:
 *   - attendance upserts today's row (overwrites), deletes the absent set
 *   - timesheets skip any user who already has an entry dated today
 *   - the leave is skipped when the taker already has a leave overlapping today
 *   - the comp-off grant is skipped when its marker remark already exists
 *
 * Prereq: dev API live on :3001 (`npm run dev`).
 * Run:    npx tsx scripts/dev-demo-today.ts
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../src/utils/date.js';
import { AttendanceRecord } from '../src/models/attendance-record.model.js';
import { getOrInitSettings } from '../src/services/settings.service.js';

const API = 'http://localhost:3001/api/v1';
const ADMIN_EMAIL = 'admin@viljetech.com';
const ADMIN_PASSWORD = 'Vilje@1234';
const DEMO_PASSWORD = 'Vilje@1234';

// The same-day Sick-Leave taker. Sorted-by-email this user lands in the
// "not checked in" set, so on-leave == not-present reads coherently.
const LEAVE_TAKER_EMAIL = 'sneha@viljetech.com';
// Earned comp-off recipient + a distinctive remark used as the re-run guard.
const COMPOFF_EMAIL = 'vikram@viljetech.com';
const COMPOFF_REMARK = 'Weekend release support (today demo)';

// ─── Tiny paced HTTP helper (mirrors demo-seed.ts: 550ms gap + 429 backoff) ─

interface ApiResult {
    status: number;
    body: any;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REQUEST_GAP_MS = 550;

async function api(method: string, path: string, body?: unknown, token?: string): Promise<ApiResult> {
    for (let attempt = 0; ; attempt += 1) {
        await sleep(REQUEST_GAP_MS);
        const res = await fetch(`${API}${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        const text = await res.text();
        let parsed: any;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = text;
        }
        if (res.status === 429 && attempt < 6) {
            console.log(`  (429 on ${method} ${path} — backing off 20s, attempt ${attempt + 1}/6)`);
            await sleep(20_000);
            continue;
        }
        return { status: res.status, body: parsed };
    }
}

const idOf = (doc: any): string => String(doc?.id ?? doc?._id);

async function login(email: string, password: string): Promise<string> {
    const r = await api('POST', '/auth/login', { email, password });
    if (r.status !== 200)
        throw new Error(`login ${email} failed (${r.status}): ${JSON.stringify(r.body)?.slice(0, 300)}`);
    return r.body.data.access_token as string;
}

// ─── Run state ──────────────────────────────────────────────────────────────

const TODAY = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
const isWeekend = [0, 6].includes(dayjs.tz(TODAY, DEFAULT_TIMEZONE).day());

interface Internal {
    id: string;
    email: string;
    full_name: string;
    role: string;
}
const counts: Record<string, number> = {};
const quirks: string[] = [];
const bump = (k: string, n = 1) => {
    counts[k] = (counts[k] ?? 0) + n;
};

let adminToken = '';
let internal: Internal[] = [];
const tokenByEmail: Record<string, string> = {};

// ─── Step 0: users ───────────────────────────────────────────────────────────

async function loadUsers(): Promise<void> {
    const r = await api('GET', '/users?limit=100', undefined, adminToken);
    const rows: any[] = r.body?.data ?? [];
    internal = rows
        .filter((u) => u.role !== 'client' && u.status === 'active')
        .map((u) => ({ id: idOf(u), email: u.email, full_name: u.full_name, role: u.role }))
        .sort((a, b) => a.email.localeCompare(b.email));
    console.log(`  ${internal.length} internal active users`);
}

// ─── Step 1: attendance today (direct Mongo, backdated morning punches) ──────

const at = (minuteOfDay: number): Date => {
    const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
    const mm = String(minuteOfDay % 60).padStart(2, '0');
    return dayjs.tz(`${TODAY} ${hh}:${mm}`, DEFAULT_TIMEZONE).toDate();
};

async function seedAttendance(): Promise<void> {
    console.log('\n── Attendance (today, direct Mongo) ──');
    const settings = await getOrInitSettings();
    const [sh, sm] = String(settings.work_schedule?.start_time ?? '09:00')
        .split(':')
        .map(Number);
    const startMin = sh * 60 + (sm || 0);

    const admin = internal.find((u) => u.role === 'admin');
    const rest = internal.filter((u) => u.role !== 'admin'); // already email-sorted

    // Deterministic, spread-out distribution (same shape as dev-demo-attendance).
    const absentIdx = new Set([0, 4, 8]);
    const lateIdx = new Set([2, 5, 9]);
    const PRESENT_OFFSETS = [-9, -4, 1, 6, 9, -6, 3]; // minutes from start (<= +10 grace)
    const LATE_OFFSETS = [34, 51, 78];

    type Plan = { user: Internal; state: 'present' | 'late' | 'absent'; inMin?: number };
    const plan: Plan[] = [];
    if (admin) plan.push({ user: admin, state: 'present', inMin: startMin - 5 });

    let pIdx = 0;
    let lIdx = 0;
    rest.forEach((u, i) => {
        // The leave taker's row is owned by the leave step (an `on_leave`
        // placeholder written after approval) — leave them out of this pass.
        if (u.email === LEAVE_TAKER_EMAIL) return;
        const state: Plan['state'] = absentIdx.has(i) ? 'absent' : lateIdx.has(i) ? 'late' : 'present';
        if (state === 'present')
            plan.push({ user: u, state, inMin: startMin + PRESENT_OFFSETS[pIdx++ % PRESENT_OFFSETS.length] });
        else if (state === 'late')
            plan.push({ user: u, state, inMin: startMin + LATE_OFFSETS[lIdx++ % LATE_OFFSETS.length] });
        else plan.push({ user: u, state });
    });

    let present = 0,
        late = 0,
        absent = 0;
    for (const p of plan) {
        if (p.state === 'absent') {
            await AttendanceRecord.deleteOne({ user_id: p.user.id, local_date: TODAY });
            absent++;
            continue;
        }
        const punch = { time: at(p.inMin!), method: 'manual' as const, location_id: null, ip: '' };
        const doc = {
            user_id: p.user.id,
            local_date: TODAY,
            segments: [{ check_in: punch, check_out: null, breaks: [] }],
            check_in: punch,
            check_out: null,
            total_worked_minutes: null,
            overtime_minutes: 0,
            total_break_minutes: 0,
            break_minutes_by_type: { lunch: 0, tea: 0, other: 0 },
            status: 'present' as const,
            flagged_for_correction: false,
            wfh: false,
            notes: '',
        };
        await AttendanceRecord.findOneAndUpdate({ user_id: p.user.id, local_date: TODAY }, doc, {
            upsert: true,
            new: true,
            setDefaultsOnInsert: true,
        });
        if (p.state === 'late') late++;
        else present++;
    }
    bump('checked_in', present + late);
    console.log(`  present(on-time) ${present} · late ${late} · not-checked-in ${absent}`);
}

/**
 * Write the EOD-finalizer's `on_leave` placeholder now, so the dashboard's
 * attendance-today card counts the leave taker as on-leave mid-day instead of
 * only after the 23:00 cron. Idempotent upsert; forces status even over a
 * stale row from a prior run.
 */
async function markOnLeaveAttendance(userId: string): Promise<void> {
    await AttendanceRecord.updateOne(
        { user_id: userId, local_date: TODAY },
        {
            $set: {
                status: 'on_leave',
                check_in: null,
                check_out: null,
                total_worked_minutes: null,
                overtime_minutes: 0,
                flagged_for_correction: false,
                wfh: false,
            },
            $setOnInsert: { user_id: userId, local_date: TODAY, notes: '' },
        },
        { upsert: true }
    );
    bump('on_leave', 1);
}

// ─── Step 2: timesheets today (API, as each user) ────────────────────────────

/** Up to `n` non-done tasks assigned to a user, as {project_id, task_id, title}. */
async function tasksFor(
    userId: string,
    n: number
): Promise<Array<{ project_id: string; task_id: string; title: string }>> {
    const r = await api('GET', `/tasks?assignee_id=${userId}&limit=20`, undefined, adminToken);
    const rows: any[] = r.body?.data ?? [];
    return rows
        .filter((t) => t.status !== 'done')
        .slice(0, n)
        .map((t) => ({ project_id: String(t.project_id), task_id: idOf(t), title: t.title }));
}

async function seedTimesheets(): Promise<void> {
    console.log('\n── Timesheets (today, via API) ──');
    for (const u of internal) {
        if (u.role === 'admin') continue; // presenter doesn't log time
        if (u.email === LEAVE_TAKER_EMAIL) continue; // on leave today

        const token = tokenByEmail[u.email];
        if (!token) {
            quirks.push(`timesheet ${u.email}: no token (login failed) — skipped`);
            continue;
        }

        // Idempotency: skip users who already have an entry dated today.
        const day = await api('GET', `/timesheets/me/day/${TODAY}`, undefined, token);
        if ((day.body?.data ?? []).length > 0) {
            console.log(`  ${u.email}: already has today's entries — skipping`);
            continue;
        }

        const myTasks = await tasksFor(u.id, 2);
        let entries = 0;
        if (myTasks.length >= 1) {
            const specs = [
                { t: myTasks[0], bh: 4, bm: 0, nbh: 0, nbm: 0, verb: 'Worked on' },
                ...(myTasks[1] ? [{ t: myTasks[1], bh: 2, bm: 30, nbh: 1, nbm: 0, verb: 'Progress on' }] : []),
            ];
            for (const s of specs) {
                const r = await api(
                    'POST',
                    '/timesheets',
                    {
                        local_date: TODAY,
                        entry_type: 'task_linked',
                        project_id: s.t.project_id,
                        task_id: s.t.task_id,
                        billable_hours: s.bh,
                        billable_minutes: s.bm,
                        non_billable_hours: s.nbh,
                        non_billable_minutes: s.nbm,
                        description: `${s.verb} ${s.t.title}`,
                    },
                    token
                );
                if (r.status === 201) entries++;
                else quirks.push(`timesheet ${u.email} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 160)}`);
            }
        } else {
            // No assigned tasks (managers) — general entries.
            const generals = [
                {
                    cat: 'Meeting',
                    bh: 3,
                    bm: 0,
                    nbh: 1,
                    nbm: 0,
                    desc: 'Sprint coordination, standups and delivery reviews',
                },
                { cat: 'Internal discussion', bh: 2, bm: 30, nbh: 0, nbm: 30, desc: 'Roadmap planning and team 1:1s' },
            ];
            for (const g of generals) {
                const r = await api(
                    'POST',
                    '/timesheets',
                    {
                        local_date: TODAY,
                        entry_type: 'general',
                        general_category: g.cat,
                        billable_hours: g.bh,
                        billable_minutes: g.bm,
                        non_billable_hours: g.nbh,
                        non_billable_minutes: g.nbm,
                        description: g.desc,
                    },
                    token
                );
                if (r.status === 201) entries++;
                else quirks.push(`timesheet ${u.email} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 160)}`);
            }
        }
        bump('timesheet_entries', entries);
        console.log(`  ${u.email}: ${entries} entries`);
    }
}

// ─── Step 3: same-day sick leave (API) ───────────────────────────────────────

async function seedLeaveToday(): Promise<void> {
    console.log('\n── Leave (same-day SL, via API) ──');
    if (isWeekend) {
        quirks.push(`today (${TODAY}) is a weekend — skipped same-day SL (engine excludes weekends)`);
        console.log('  today is a weekend — skipped');
        return;
    }
    const taker = internal.find((u) => u.email === LEAVE_TAKER_EMAIL);
    if (!taker) {
        quirks.push(`leave: taker ${LEAVE_TAKER_EMAIL} not found — skipped`);
        return;
    }

    // Idempotency: skip the apply when the taker already has a leave overlapping
    // today — but still (re)assert the on_leave attendance placeholder so a
    // re-run self-heals the dashboard card.
    const existing = await api(
        'GET',
        `/leaves?user_id=${taker.id}&from_date=${TODAY}&to_date=${TODAY}&limit=5`,
        undefined,
        adminToken
    );
    if ((existing.body?.data ?? []).length > 0) {
        await markOnLeaveAttendance(taker.id);
        console.log(`  ${taker.email} already has a leave for today — reasserted on_leave attendance`);
        return;
    }

    const types = (await api('GET', '/leave-types', undefined, adminToken)).body?.data ?? [];
    const sl = types.find((t: any) => t.code === 'SL');
    if (!sl) {
        quirks.push('leave: SL leave type not found — skipped');
        return;
    }

    const token = tokenByEmail[taker.email];
    if (!token) {
        quirks.push(`leave ${taker.email}: no token — skipped`);
        return;
    }
    const applied = await api(
        'POST',
        '/leaves',
        {
            leave_type_id: idOf(sl),
            start_date: TODAY,
            end_date: TODAY,
            reason: 'Migraine — taking the day off',
        },
        token
    );
    if (applied.status !== 201 && applied.status !== 200) {
        quirks.push(`leave apply ${taker.email} → ${applied.status}: ${JSON.stringify(applied.body)?.slice(0, 200)}`);
        return;
    }
    const leaveId = idOf(applied.body.data);
    bump('leaves_applied');

    const approved = await api(
        'POST',
        `/leaves/${leaveId}/approve`,
        { approver_remarks: 'Approved — rest up.' },
        adminToken
    );
    if (approved.status === 200) {
        bump('leaves_approved');
        await markOnLeaveAttendance(taker.id);
        console.log(`  ${taker.email}: SL ${TODAY} applied + approved (+ on_leave attendance)`);
    } else {
        quirks.push(
            `leave approve ${taker.email} → ${approved.status}: ${JSON.stringify(approved.body)?.slice(0, 200)}`
        );
        console.log(`  ${taker.email}: SL applied (approve failed — stays pending)`);
    }
}

// ─── Step 4: comp-off earned grant today (API) ───────────────────────────────

async function seedCompOff(): Promise<void> {
    console.log('\n── Comp-off (earned grant, via API) ──');
    const recipient = internal.find((u) => u.email === COMPOFF_EMAIL);
    if (!recipient) {
        quirks.push(`comp-off: recipient ${COMPOFF_EMAIL} not found — skipped`);
        return;
    }

    // Idempotency: skip when a ledger row with our marker remark already exists.
    const ledger = await api('GET', `/comp-off?user_id=${recipient.id}&limit=100`, undefined, adminToken);
    const already = (ledger.body?.data ?? []).some((row: any) => row.remarks === COMPOFF_REMARK);
    if (already) {
        console.log(`  ${recipient.email} already has today's comp-off grant — skipping`);
        return;
    }

    const r = await api(
        'POST',
        '/comp-off/adjust',
        {
            user_id: recipient.id,
            type: 'earned',
            days: 1,
            remarks: COMPOFF_REMARK,
        },
        adminToken
    );
    if (r.status === 200 || r.status === 201) {
        bump('comp_off_grants');
        console.log(`  ${recipient.email}: +1d earned`);
    } else {
        quirks.push(`comp-off ${recipient.email} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 200)}`);
    }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log(`Demo "today" seed — today (IST) = ${TODAY}${isWeekend ? ' (weekend)' : ''}`);
    await connectDB();
    adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);
    await loadUsers();

    // Log in every internal user up-front (they share the demo password).
    for (const u of internal) {
        if (u.role === 'admin') {
            tokenByEmail[u.email] = adminToken;
            continue;
        }
        try {
            tokenByEmail[u.email] = await login(u.email, DEMO_PASSWORD);
        } catch (e) {
            quirks.push(`login ${u.email} failed: ${String((e as Error).message).slice(0, 120)}`);
        }
    }

    await seedAttendance();
    await seedTimesheets();
    await seedLeaveToday();
    await seedCompOff();

    console.log('\n── Summary ──');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(20)}${v}`);
    if (quirks.length) {
        console.log('\n── Quirks / notes ──');
        for (const q of quirks) console.log(`  - ${q}`);
    }
    console.log('\nDone.');
    await disconnectDB();
}

main().catch(async (err) => {
    console.error(err);
    await disconnectDB().catch(() => {});
    process.exit(1);
});
