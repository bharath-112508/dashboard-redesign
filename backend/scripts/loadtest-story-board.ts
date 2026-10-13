/**
 * Story-board load test — Step 26 Phase-2 exit criterion.
 *
 *   "Story-board P95 < 200 ms on 200-task project (load test)"
 *
 * What it does:
 *   1. Seeds an isolated load-test project owned by a fresh admin
 *      (uses a deterministic email so re-runs reuse the same fixtures
 *      via upsert; no hard reset needed).
 *   2. Distributes 200 tasks across 4 default statuses + 10 stories
 *      so the project has the same shape a kanban board renders.
 *   3. Authenticates against the live HTTP server (assumes
 *      `npm run dev` is running on port 3001) and fires N concurrent
 *      `GET /tasks?project_id=…&limit=200` requests against it.
 *   4. Measures wall-clock latency per request, computes p50 / p95 /
 *      p99, and asserts p95 < 200 ms. Exits non-zero if the threshold
 *      is breached so this script can be wired into a CI gate.
 *
 * Usage:
 *   npx tsx scripts/loadtest-story-board.ts                       # 100 reqs
 *   LOADTEST_REQUESTS=500 npx tsx scripts/loadtest-story-board.ts # custom
 *   LOADTEST_CONCURRENCY=20 npx tsx scripts/loadtest-story-board.ts
 *   LOADTEST_API=http://staging.example/api/v1 npx tsx scripts/loadtest-story-board.ts
 *
 * Why a TS load test instead of `autocannon` / `k6`:
 *   - We need to seed Mongo first; bringing the platform's own model
 *     code to do that is more honest than hand-rolling fixtures.
 *   - The per-request latency we care about is wall-clock against a
 *     real Express handler, which `fetch` measures precisely.
 *   - Zero new dependencies — we already have everything we need.
 *
 * Threshold rationale (200 ms p95):
 *   - The story-board is a hot user surface; any p95 above ~250 ms
 *     starts feeling sluggish on slower client networks.
 *   - The 200 ms ceiling comes straight from BUILD_PROGRESS Step 26.
 */

import process from 'node:process';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { User } from '../src/models/user.model.js';
import { Project } from '../src/models/project.model.js';
import { Sprint } from '../src/models/sprint.model.js';
import { Story } from '../src/models/story.model.js';
import { Task } from '../src/models/task.model.js';
import { hashPassword } from '../src/utils/password.js';
import { ROLES } from '../src/constants/roles.js';
import { USER_STATUSES } from '../src/constants/user-statuses.js';
import { PROJECT_STATUSES } from '../src/constants/project.js';
import { DEFAULT_TASK_STATUSES, TASK_PRIORITIES } from '../src/constants/task.js';

// ─── Config ───────────────────────────────────────────────────────────────

const API_BASE = process.env.LOADTEST_API ?? 'http://localhost:3001/api/v1';
// 500 is the default sample count: at concurrency 10 that gives ~25
// measurements per concurrent slot, enough for a stable p95 reading.
// 100 (the previous default) had 5 samples in the tail and would produce
// flappy CI gates. Override via env when running a quick local smoke.
const TOTAL_REQUESTS = Number(process.env.LOADTEST_REQUESTS ?? '500');
const CONCURRENCY = Number(process.env.LOADTEST_CONCURRENCY ?? '10');
const P95_THRESHOLD_MS = Number(process.env.LOADTEST_P95_THRESHOLD_MS ?? '200');

const SEED_EMAIL = 'loadtest-admin@example.com';
const SEED_PASSWORD = 'LoadTest@2026!';
const PROJECT_CODE = 'LOAD-26';
const PROJECT_NAME = 'Step 26 load-test project';
const TASK_COUNT = 200;
const STORY_COUNT = 10;
const SPRINT_COUNT = 5;

const STATUSES = Object.values(DEFAULT_TASK_STATUSES);
const PRIORITIES = Object.values(TASK_PRIORITIES);

// ─── Helpers ──────────────────────────────────────────────────────────────

const log = (msg: string): void => {
    console.log(msg);
};

// `function` declaration (not an arrow) so TS narrows callers via the
// `: never` return type — `if (!x) fail(...)` after this point treats
// `x` as non-nullable, which the arrow form doesn't always propagate
// through control-flow analysis.
function fail(msg: string): never {
    console.error(`\x1b[31m${msg}\x1b[0m`);
    process.exit(1);
}

/**
 * Nearest-rank percentile per RFC 8932 §B.2 / NIST handbook §1.3.5.6.
 *
 * For a sorted sample of N items, the p-th percentile is the
 * `ceil(p/100 * N)`-th value (1-indexed) — i.e. index
 * `Math.ceil(p/100 * N) - 1` in a 0-indexed array. The previous
 * implementation used `Math.floor(p/100 * N)` which yields the
 * (k+1)-th value at percentile boundaries — overstates p95 by one
 * sample slot on round counts (100, 1 000, …) and produces a stricter-
 * than-spec gate.
 */
const percentile = (sorted: number[], p: number): number => {
    if (sorted.length === 0) return 0;
    const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
    return sorted[Math.min(sorted.length - 1, rank - 1)];
};

// ─── Seed phase (Mongo) ───────────────────────────────────────────────────

const seedFixtures = async (): Promise<{ projectId: string }> => {
    log('── Seeding fixtures ──────────────────────────────────────────');

    // 1. Admin (idempotent upsert)
    const password_hash = await hashPassword(SEED_PASSWORD);
    const adminRes = await User.findOneAndUpdate(
        { email: SEED_EMAIL },
        {
            $set: {
                email: SEED_EMAIL,
                password_hash,
                full_name: 'Load Test Admin',
                role: ROLES.ADMIN,
                status: USER_STATUSES.ACTIVE,
                timezone: 'Asia/Kolkata',
                mfa_enabled: false,
                failed_login_attempts: 0,
                locked_until: null,
            },
        },
        { upsert: true, new: true }
    );
    if (!adminRes) fail('failed to upsert seed admin');

    // 2. Project (idempotent on `code`).
    //
    // Date fields on this platform are stored as ISO `YYYY-MM-DD`
    // strings, not JS Date objects (Data_Model §Dates: "Store local
    // dates as ISO date strings to avoid timezone skew"). The schema's
    // `match: ISO_DATE_REGEX` rejects anything else.
    const projectRes = await Project.findOneAndUpdate(
        { code: PROJECT_CODE },
        {
            $set: {
                name: PROJECT_NAME,
                code: PROJECT_CODE,
                description: 'Auto-seeded for Step-26 story-board load test.',
                start_date: '2026-01-01',
                end_date: null,
                status: PROJECT_STATUSES.ACTIVE,
                is_archived: false,
                member_ids: [adminRes._id],
                client_ids: [],
                custom_task_statuses: [],
                created_by: adminRes._id,
            },
        },
        { upsert: true, new: true }
    );
    if (!projectRes) fail('failed to upsert seed project');
    const projectId = projectRes._id;

    // 3. Wipe + reseed sprints/stories/tasks for this project so the row
    //    count is exactly what the test expects on every run.
    await Promise.all([
        Sprint.deleteMany({ project_id: projectId }),
        Story.deleteMany({ project_id: projectId }),
        Task.deleteMany({ project_id: projectId }),
    ]);

    // 4. Sprints. Same string-date contract as the project — the
    // sprint schema validates against `ISO_DATE_REGEX`. Each sprint
    // covers a one-week window so the ranges don't overlap.
    const padDay = (n: number): string => String(n).padStart(2, '0');
    const sprints = await Sprint.insertMany(
        Array.from({ length: SPRINT_COUNT }, (_, i) => ({
            project_id: projectId,
            name: `Sprint ${i + 1}`,
            status: 'active',
            start_date: `2026-01-${padDay(1 + i * 7)}`,
            end_date: `2026-01-${padDay(7 + i * 7)}`,
            created_by: adminRes._id,
        }))
    );

    // 5. Stories. Schema field is `position` (integer ≥ 0) — distinct
    // values give the story-board a real ordering instead of
    // collapsing every row to position 0.
    const stories = await Story.insertMany(
        Array.from({ length: STORY_COUNT }, (_, i) => ({
            project_id: projectId,
            title: `Load test story #${i + 1}`,
            description: '',
            position: i,
            created_by: adminRes._id,
        }))
    );

    // 6. Tasks — distributed across statuses, priorities, sprints, stories
    //    so the index reads exercise the same selectivity a real board
    //    would. `due_date` is required by the schema (Data_Model §5.4
    //    spec'd it as a non-nullable ISO date); we cycle across two
    //    months so the `{due_date}` index isn't single-valued.
    const dueDateFor = (i: number): string => {
        const month = (i % 12) + 1; // 1..12
        const day = (i % 28) + 1; // 1..28 — safe for every month
        return `2026-${padDay(month)}-${padDay(day)}`;
    };
    const tasksToInsert = Array.from({ length: TASK_COUNT }, (_, i) => ({
        project_id: projectId,
        sprint_id: sprints[i % SPRINT_COUNT]._id,
        story_id: stories[i % STORY_COUNT]._id,
        parent_task_id: null,
        title: `Load test task #${i + 1}`,
        description: '',
        status: STATUSES[i % STATUSES.length],
        priority: PRIORITIES[i % PRIORITIES.length],
        primary_assignee_id: null,
        collaborator_ids: [],
        estimated_hours: null,
        due_date: dueDateFor(i),
        position: i,
        depends_on_task_ids: [],
        created_by: adminRes._id,
        updated_by: adminRes._id,
    }));
    await Task.insertMany(tasksToInsert);

    log(`   admin: ${SEED_EMAIL}`);
    log(`   project: ${PROJECT_NAME} (${projectId.toString()})`);
    log(`   sprints: ${SPRINT_COUNT} · stories: ${STORY_COUNT} · tasks: ${TASK_COUNT}`);

    return { projectId: projectId.toString() };
};

// ─── HTTP phase ───────────────────────────────────────────────────────────

const login = async (): Promise<string> => {
    const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: SEED_EMAIL, password: SEED_PASSWORD }),
    });
    if (!res.ok) {
        fail(`login failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { data?: { access_token?: string } };
    const token = body?.data?.access_token;
    if (!token) fail('login response missing access_token');
    return token;
};

const measureOnce = async (token: string, projectId: string): Promise<{ ms: number; ok: boolean; status: number }> => {
    const t0 = performance.now();
    const res = await fetch(`${API_BASE}/tasks?project_id=${encodeURIComponent(projectId)}&limit=200`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    // Drain the body so the server-side write completes — without this
    // the latency measurement would understate the real cost.
    await res.text();
    const ms = performance.now() - t0;
    return { ms, ok: res.ok, status: res.status };
};

const runConcurrencyPool = async (
    total: number,
    concurrency: number,
    work: () => Promise<{ ms: number; ok: boolean; status: number }>
): Promise<{ ms: number; ok: boolean; status: number }[]> => {
    const results: { ms: number; ok: boolean; status: number }[] = [];
    let next = 0;

    const worker = async (): Promise<void> => {
        while (true) {
            const idx = next;
            next += 1;
            if (idx >= total) return;
            const r = await work();
            results.push(r);
        }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
};

// ─── Main ─────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
    log('════════════════════════════════════════════════════════════════');
    log('  Step 26 — Story-board load test');
    log('════════════════════════════════════════════════════════════════');
    log(`  api:           ${API_BASE}`);
    log(`  requests:      ${TOTAL_REQUESTS}`);
    log(`  concurrency:   ${CONCURRENCY}`);
    log(`  p95 threshold: ${P95_THRESHOLD_MS} ms`);
    log('');

    // Pre-flight: dev server must be reachable.
    try {
        const ping = await fetch(API_BASE.replace(/\/api\/v1$/, '/health'));
        if (!ping.ok) fail(`health check returned ${ping.status} — is the dev server running?`);
    } catch (err) {
        fail(`cannot reach ${API_BASE} — is the dev server running? (${(err as Error).message})`);
    }

    await connectDB();
    let projectId: string;
    try {
        ({ projectId } = await seedFixtures());
    } finally {
        // Disconnect the seed connection so the live HTTP server doesn't
        // share Mongoose state with us; the request path goes through
        // its own pool.
        await disconnectDB();
    }

    log('');
    log('── Authenticating ───────────────────────────────────────────');
    const token = await login();
    log('   ok');

    log('');
    log('── Warming up (10 sequential requests, untracked) ───────────');
    for (let i = 0; i < 10; i += 1) {
        const r = await measureOnce(token, projectId);
        if (!r.ok) fail(`warm-up request ${i + 1} returned ${r.status}`);
    }
    log('   ok');

    log('');
    log(`── Firing ${TOTAL_REQUESTS} requests at concurrency ${CONCURRENCY} ──`);
    const t0 = performance.now();
    const results = await runConcurrencyPool(TOTAL_REQUESTS, CONCURRENCY, () => measureOnce(token, projectId));
    const wall = performance.now() - t0;

    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
        fail(
            `${failures.length}/${TOTAL_REQUESTS} requests failed (statuses: ${[...new Set(failures.map((f) => f.status))].join(', ')})`
        );
    }

    const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
    const min = latencies[0];
    const max = latencies[latencies.length - 1];
    const mean = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p50 = percentile(latencies, 50);
    const p95 = percentile(latencies, 95);
    const p99 = percentile(latencies, 99);
    const rps = (TOTAL_REQUESTS * 1000) / wall;

    log('');
    log('── Latency distribution (ms) ─────────────────────────────────');
    log(`   min  ${min.toFixed(1).padStart(7)}`);
    log(`   p50  ${p50.toFixed(1).padStart(7)}`);
    log(`   mean ${mean.toFixed(1).padStart(7)}`);
    log(`   p95  ${p95.toFixed(1).padStart(7)}    threshold ${P95_THRESHOLD_MS}`);
    log(`   p99  ${p99.toFixed(1).padStart(7)}`);
    log(`   max  ${max.toFixed(1).padStart(7)}`);
    log(`   rps  ${rps.toFixed(1).padStart(7)}    (${TOTAL_REQUESTS} requests in ${(wall / 1000).toFixed(2)} s)`);

    log('');
    if (p95 > P95_THRESHOLD_MS) {
        fail(`✗ FAIL — p95 ${p95.toFixed(1)} ms exceeds the ${P95_THRESHOLD_MS} ms exit criterion`);
    }
    log(`\x1b[32m✓ PASS — p95 ${p95.toFixed(1)} ms is under the ${P95_THRESHOLD_MS} ms exit criterion\x1b[0m`);
};

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
