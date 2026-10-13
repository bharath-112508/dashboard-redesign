/**
 * DEMO role accounts seeder — gives ONE representative account per internal
 * role (admin / team lead / employee) a full set of self-service data so a
 * demo can log in as any of them and every personal tab is populated:
 *
 *   - Timesheets — entries across the last ~8 working days + today
 *   - Leaves     — an approved PAST leave, an approved RECENT leave, and an
 *                  UPCOMING pending request (mix of CL + SL)
 *   - Comp-off   — an earned grant + a partial consume (a real ledger + balance)
 *
 * Recommended demo accounts (all share the password `Vilje@1234`):
 *   - admin@viljetech.com   (admin)
 *   - kavya@viljetech.com   (team lead)
 *   - ananya@viljetech.com  (employee)
 *
 * Notes:
 *   - Backdated / same-day leaves are allowed by the API (the advance-notice +
 *     no-backdate gates were removed — see leave-request.service.ts), so we can
 *     seed realistic past + upcoming history.
 *   - Self-approval is refused, so the admin's own leaves are approved by a
 *     manager (priya); the team-lead's and employee's are approved by admin.
 *
 * Idempotent — safe to re-run:
 *   - timesheets skip any (user, day) that already has an entry
 *   - a leave is skipped when the user already has one with the same reason
 *   - a comp-off row is skipped when its marker remark already exists
 *
 * Targets the DB the running :3001 server is on — keep it on vilje-platform-demo.
 * Prereq: dev API live on :3001 (`npm run dev`).
 * Run:    npx tsx scripts/dev-demo-role-accounts.ts
 */
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../src/utils/date.js';

const API = 'http://localhost:3001/api/v1';
const ADMIN_EMAIL = 'admin@viljetech.com';
const PASSWORD = 'Vilje@1234';

// The manager who approves the admin's own leaves (admin can't self-approve).
const MANAGER_APPROVER_EMAIL = 'priya@viljetech.com';

// Leave type ids (stable across the demo DB; resolved by code at runtime too).
const LEAVE_CODES = { CL: 'CL', SL: 'SL' } as const;

// The representative account per role we fully populate + recommend.
const DEMO_ACCOUNTS = [
    { key: 'admin', email: 'admin@viljetech.com', role: 'admin' },
    { key: 'team_lead', email: 'kavya@viljetech.com', role: 'team_lead' },
    { key: 'employee', email: 'ananya@viljetech.com', role: 'employee' },
];

// ─── Tiny paced HTTP helper (mirrors demo-seed.ts: 550ms gap + 429 backoff) ─

interface ApiResult {
    status: number;
    body: any;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REQUEST_GAP_MS = 500;

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
            console.log(`  (429 on ${method} ${path} — backing off 20s)`);
            await sleep(20_000);
            continue;
        }
        return { status: res.status, body: parsed };
    }
}

const idOf = (doc: any): string => String(doc?.id ?? doc?._id);

async function login(email: string): Promise<string> {
    const r = await api('POST', '/auth/login', { email, password: PASSWORD });
    if (r.status !== 200)
        throw new Error(`login ${email} failed (${r.status}): ${JSON.stringify(r.body)?.slice(0, 200)}`);
    return r.body.data.access_token as string;
}

// ─── Date helpers (IST, weekdays only) ──────────────────────────────────────

const TODAY = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
const isWeekend = (ymd: string) => [0, 6].includes(dayjs.tz(ymd, DEFAULT_TIMEZONE).day());
const addDays = (ymd: string, n: number) => dayjs.tz(ymd, DEFAULT_TIMEZONE).add(n, 'day').format(DATE_FORMAT);

/** N working days strictly before TODAY, ascending, plus TODAY itself. */
function workingDaysThrough(today: string, n: number): string[] {
    const out: string[] = [];
    let d = addDays(today, -1);
    while (out.length < n) {
        if (!isWeekend(d)) out.unshift(d);
        d = addDays(d, -1);
    }
    if (!isWeekend(today)) out.push(today);
    return out;
}

/** Next weekday on/after ymd. */
function nextWeekday(ymd: string): string {
    let d = ymd;
    while (isWeekend(d)) d = addDays(d, 1);
    return d;
}

// ─── Run state ──────────────────────────────────────────────────────────────

const counts: Record<string, number> = {};
const quirks: string[] = [];
const bump = (k: string, n = 1) => {
    counts[k] = (counts[k] ?? 0) + n;
};

let adminToken = '';
let managerToken = '';
const leaveTypeId: Record<string, string> = {};
const tokenByEmail: Record<string, string> = {};
const idByEmail: Record<string, string> = {};

// ─── Timesheets ──────────────────────────────────────────────────────────────

/** Up to `n` non-done tasks assigned to a user (as admin), for task-linked rows. */
async function tasksFor(
    userId: string,
    n: number
): Promise<Array<{ project_id: string; task_id: string; title: string }>> {
    const r = await api('GET', `/tasks?assignee_id=${userId}&limit=20`, undefined, adminToken);
    return (r.body?.data ?? [])
        .filter((t: any) => t.status !== 'done')
        .slice(0, n)
        .map((t: any) => ({ project_id: String(t.project_id), task_id: idOf(t), title: t.title }));
}

async function seedTimesheets(acc: { key: string; email: string }, userId: string, token: string): Promise<void> {
    const days = workingDaysThrough(TODAY, 7); // last 7 working days + today
    const myTasks = await tasksFor(userId, 2);
    let created = 0;

    for (let di = 0; di < days.length; di += 1) {
        const date = days[di]!;
        const day = await api('GET', `/timesheets/me/day/${date}`, undefined, token);
        if ((day.body?.data ?? []).length > 0) continue; // idempotent per day

        const entries =
            myTasks.length >= 1
                ? [
                      {
                          local_date: date,
                          entry_type: 'task_linked',
                          project_id: myTasks[0]!.project_id,
                          task_id: myTasks[0]!.task_id,
                          billable_hours: 4,
                          billable_minutes: 0,
                          non_billable_hours: 0,
                          non_billable_minutes: 0,
                          description: `Worked on ${myTasks[0]!.title}`,
                      },
                      {
                          local_date: date,
                          entry_type: 'task_linked',
                          project_id: (myTasks[1] ?? myTasks[0])!.project_id,
                          task_id: (myTasks[1] ?? myTasks[0])!.task_id,
                          billable_hours: 2,
                          billable_minutes: 30,
                          non_billable_hours: 1,
                          non_billable_minutes: 0,
                          description: `Progress on ${(myTasks[1] ?? myTasks[0])!.title}`,
                      },
                  ]
                : [
                      // No project on these, so `general_category` is the only
                      // thing attributing the hour and has to come off
                      // TIMESHEET_GENERAL_CATEGORIES.
                      {
                          local_date: date,
                          entry_type: 'general',
                          general_category: 'Meeting',
                          billable_hours: 3,
                          billable_minutes: 0,
                          non_billable_hours: 1,
                          non_billable_minutes: 0,
                          description: 'Standups, delivery reviews and coordination',
                      },
                      {
                          local_date: date,
                          entry_type: 'general',
                          general_category: 'Internal discussion',
                          billable_hours: 2,
                          billable_minutes: 30,
                          non_billable_hours: 0,
                          non_billable_minutes: 30,
                          description: 'Roadmap planning and team 1:1s',
                      },
                  ];

        for (const e of entries) {
            const r = await api('POST', '/timesheets', e, token);
            if (r.status === 201) created += 1;
            else quirks.push(`timesheet ${acc.key} ${date} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 140)}`);
        }
    }
    bump('timesheet_entries', created);
    console.log(`  timesheets: ${created} new entries (${myTasks.length ? 'task-linked' : 'general'})`);
}

// ─── Leaves ──────────────────────────────────────────────────────────────────

interface LeavePlan {
    code: 'CL' | 'SL';
    start: string;
    end: string;
    reason: string;
    approve: boolean;
}

async function seedLeaves(acc: { key: string; email: string }, userId: string, token: string): Promise<void> {
    // Existing reasons for this user → idempotency.
    const existing = await api('GET', `/leaves?user_id=${userId}&limit=100`, undefined, adminToken);
    const existingReasons = new Set<string>((existing.body?.data ?? []).map((l: any) => l.reason));

    const plans: LeavePlan[] = [
        {
            code: 'CL',
            start: '2026-06-23',
            end: '2026-06-24',
            reason: `Family function · ${acc.key} demo`,
            approve: true,
        },
        {
            code: 'SL',
            start: '2026-07-07',
            end: '2026-07-07',
            reason: `Fever, rest day · ${acc.key} demo`,
            approve: true,
        },
        {
            // +14d keeps this clear of other demo accounts' pre-seeded leaves
            // (a nearer window overlapped an employee's existing request).
            code: 'CL',
            start: nextWeekday(addDays(TODAY, 14)),
            end: nextWeekday(addDays(addDays(TODAY, 14), 1)),
            reason: `Short trip · ${acc.key} demo`,
            approve: false, // stays pending
        },
    ];

    // Admin can't self-approve → a manager approves the admin's leaves.
    const approverToken = acc.email === ADMIN_EMAIL ? managerToken : adminToken;
    let applied = 0;
    let approved = 0;

    for (const p of plans) {
        if (existingReasons.has(p.reason)) {
            continue;
        }
        const r = await api(
            'POST',
            '/leaves',
            { leave_type_id: leaveTypeId[p.code], start_date: p.start, end_date: p.end, reason: p.reason },
            token
        );
        if (r.status !== 201 && r.status !== 200) {
            quirks.push(
                `leave ${acc.key} ${p.code} ${p.start} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 160)}`
            );
            continue;
        }
        applied += 1;
        if (!p.approve) continue;

        const leaveId = idOf(r.body.data);
        const ap = await api(
            'POST',
            `/leaves/${leaveId}/approve`,
            { approver_remarks: 'Approved — enjoy / rest up.' },
            approverToken
        );
        if (ap.status === 200) approved += 1;
        else quirks.push(`approve ${acc.key} ${p.code} → ${ap.status}: ${JSON.stringify(ap.body)?.slice(0, 160)}`);
    }
    bump('leaves_applied', applied);
    bump('leaves_approved', approved);
    console.log(`  leaves: ${applied} applied (${approved} approved, ${applied - approved} pending)`);
}

// ─── Comp-off ────────────────────────────────────────────────────────────────

async function seedCompOff(acc: { key: string }, userId: string): Promise<void> {
    const ledger = await api('GET', `/comp-off?user_id=${userId}&limit=100`, undefined, adminToken);
    const remarks = new Set<string>((ledger.body?.data ?? []).map((r: any) => r.remarks));

    const rows = [
        { type: 'earned', days: 2, remarks: `Weekend release support · ${acc.key} demo` },
        { type: 'consumed', days: 0.5, remarks: `Half-day comp-off availed · ${acc.key} demo` },
    ];
    let done = 0;
    for (const row of rows) {
        if (remarks.has(row.remarks)) continue;
        const r = await api(
            'POST',
            '/comp-off/adjust',
            { user_id: userId, type: row.type, days: row.days, remarks: row.remarks },
            adminToken
        );
        if (r.status === 200 || r.status === 201) done += 1;
        else quirks.push(`comp-off ${acc.key} ${row.type} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 160)}`);
    }
    bump('comp_off_rows', done);
    console.log(`  comp-off: ${done} new ledger rows`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log(`Demo role-accounts seed — today (IST) = ${TODAY}`);
    adminToken = await login(ADMIN_EMAIL);
    managerToken = await login(MANAGER_APPROVER_EMAIL);

    // Resolve leave-type ids by code.
    const types = (await api('GET', '/leave-types', undefined, adminToken)).body?.data ?? [];
    for (const code of Object.values(LEAVE_CODES)) {
        const t = types.find((x: any) => x.code === code);
        if (!t) throw new Error(`leave type ${code} not found`);
        leaveTypeId[code] = idOf(t);
    }

    // Resolve account ids + tokens.
    const users = (await api('GET', '/users?limit=100', undefined, adminToken)).body?.data ?? [];
    for (const acc of DEMO_ACCOUNTS) {
        const u = users.find((x: any) => x.email === acc.email);
        if (!u) throw new Error(`demo account ${acc.email} not found`);
        idByEmail[acc.email] = idOf(u);
        tokenByEmail[acc.email] = acc.email === ADMIN_EMAIL ? adminToken : await login(acc.email);
    }

    for (const acc of DEMO_ACCOUNTS) {
        console.log(`\n── ${acc.role.toUpperCase()}: ${acc.email} ──`);
        const uid = idByEmail[acc.email];
        const token = tokenByEmail[acc.email];
        await seedTimesheets(acc, uid, token);
        await seedLeaves(acc, uid, token);
        await seedCompOff(acc, uid);
    }

    console.log('\n── Summary ──');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(20)}${v}`);
    if (quirks.length) {
        console.log('\n── Quirks / notes ──');
        for (const q of quirks) console.log(`  - ${q}`);
    }

    console.log('\n── Recommended demo accounts (password: Vilje@1234) ──');
    for (const acc of DEMO_ACCOUNTS) console.log(`  ${acc.role.padEnd(10)} ${acc.email}`);
    console.log('\nDone.');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
