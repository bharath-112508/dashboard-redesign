/**
 * DEMO seed — populates realistic demo data, mostly through the HTTP API as
 * real users (so audit logs / notifications / denormalised counters behave
 * exactly like production usage). Direct Mongo is used ONLY for backdated
 * attendance history + this-morning check-in time variation (the check-in API
 * always stamps "now").
 *
 * Prereqs:
 *   - dev API on :3001 (`npm run dev`)
 *   - a fresh `scripts/demo-wipe.ts` run (admin@viljetech.com preserved)
 *
 * Run:  npx tsx scripts/demo-seed.ts
 *
 * All users (incl. admin) share the password `Vilje@1234`.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { COLLECTIONS } from '../src/constants/collections.js';
import { assertSafeDb } from './_safe-db.js';

const API = 'http://localhost:3001/api/v1';
const ADMIN_EMAIL = 'admin@viljetech.com';
const ADMIN_PASSWORD = 'Vilje@1234';
const DEMO_PASSWORD = 'Vilje@1234'; // 10 chars — policy is 10–12

// ─── Tiny HTTP helper ──────────────────────────────────────────────────────

interface ApiResult {
    status: number;
    body: any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The dev server runs a per-IP general rate limit (default 120/min). Pace
// every request and back off + retry on 429 so a full seed run never trips it.
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

function must(r: ApiResult, what: string, ...okStatuses: number[]): any {
    const ok = okStatuses.length ? okStatuses : [200, 201];
    if (!ok.includes(r.status)) {
        throw new Error(`${what} failed (${r.status}): ${JSON.stringify(r.body)?.slice(0, 500)}`);
    }
    return r.body?.data;
}

const idOf = (doc: any): string => String(doc?.id ?? doc?._id);

async function login(email: string, password: string): Promise<string> {
    const data = must(await api('POST', '/auth/login', { email, password }), `login ${email}`);
    return data.access_token as string;
}

/** Total row count of a paginated list endpoint (0 when meta is absent). */
async function listTotal(path: string, token: string): Promise<number> {
    const r = await api('GET', path, undefined, token);
    return Number(r.body?.meta?.total ?? (Array.isArray(r.body?.data) ? r.body.data.length : 0));
}

// ─── IST date helpers ──────────────────────────────────────────────────────

const IST = 'Asia/Kolkata';

function istDateString(d: Date): string {
    // en-CA gives YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(d);
}

const TODAY = istDateString(new Date());

function addDays(ymd: string, days: number): string {
    const d = new Date(`${ymd}T12:00:00+05:30`);
    d.setUTCDate(d.getUTCDate() + days);
    return istDateString(d);
}

function dayOfWeek(ymd: string): number {
    // 0=Sun … 6=Sat (the noon-IST anchor keeps this stable)
    return new Date(`${ymd}T12:00:00+05:30`).getUTCDay();
}

const isWeekend = (ymd: string): boolean => [0, 6].includes(dayOfWeek(ymd));

function nextWorkingDayOnOrAfter(ymd: string): string {
    let d = ymd;
    while (isWeekend(d)) d = addDays(d, 1);
    return d;
}

function nextMondayOnOrAfter(ymd: string): string {
    let d = ymd;
    while (dayOfWeek(d) !== 1) d = addDays(d, 1);
    return d;
}

/** N working days strictly before `ymd`, ascending. */
function workingDaysBefore(ymd: string, n: number): string[] {
    const out: string[] = [];
    let d = addDays(ymd, -1);
    while (out.length < n) {
        if (!isWeekend(d)) out.unshift(d);
        d = addDays(d, -1);
    }
    return out;
}

const istInstant = (ymd: string, hhmm: string): Date => new Date(`${ymd}T${hhmm}:00+05:30`);

// ─── Deterministic PRNG (stable re-runs) ───────────────────────────────────

let seed = 20260612;
function rand(): number {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
}
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;

// ─── Seed data tables ──────────────────────────────────────────────────────

interface UserSpec {
    key: string;
    email: string;
    full_name: string;
    role: 'manager' | 'team_lead' | 'employee' | 'client' | 'representative';
    employee_id?: string;
    job_title?: string;
    department?: string;
    date_of_joining?: string;
    reports_to?: string; // key of manager
    /** Client-side users only — key into COMPANIES. */
    company?: string;
}

/**
 * Client COMPANIES. "Client" IS the company; a "Representative" is that
 * company's project-scoped person. Seeded before users, because a client-side
 * user needs an existing `company_id`.
 */
interface CompanySpec {
    key: string;
    name: string;
}

const COMPANIES: CompanySpec[] = [
    { key: 'nordmark', name: 'Nordmark Logistics AS' },
    { key: 'aurora', name: 'Aurora Foods AB' },
];

const companyId: Record<string, string> = {};

const USERS: UserSpec[] = [
    {
        key: 'priya',
        email: 'priya@viljetech.com',
        full_name: 'Priya Sharma',
        role: 'manager',
        employee_id: 'VT-001',
        job_title: 'Engineering Manager',
        department: 'Engineering',
        date_of_joining: '2024-03-11',
    },
    {
        key: 'arjun',
        email: 'arjun@viljetech.com',
        full_name: 'Arjun Mehta',
        role: 'manager',
        employee_id: 'VT-002',
        job_title: 'Delivery Manager',
        department: 'Delivery',
        date_of_joining: '2024-05-02',
    },
    {
        key: 'kavya',
        email: 'kavya@viljetech.com',
        full_name: 'Kavya Reddy',
        role: 'team_lead',
        employee_id: 'VT-003',
        job_title: 'Frontend Lead',
        department: 'Engineering',
        date_of_joining: '2024-07-15',
        reports_to: 'priya',
    },
    {
        key: 'rohan',
        email: 'rohan@viljetech.com',
        full_name: 'Rohan Iyer',
        role: 'team_lead',
        employee_id: 'VT-004',
        job_title: 'Backend Lead',
        department: 'Delivery',
        date_of_joining: '2024-08-20',
        reports_to: 'arjun',
    },
    {
        key: 'ananya',
        email: 'ananya@viljetech.com',
        full_name: 'Ananya Krishnan',
        role: 'employee',
        employee_id: 'VT-005',
        job_title: 'Frontend Engineer',
        department: 'Engineering',
        date_of_joining: '2025-01-06',
        reports_to: 'priya',
    },
    {
        key: 'vikram',
        email: 'vikram@viljetech.com',
        full_name: 'Vikram Nair',
        role: 'employee',
        employee_id: 'VT-006',
        job_title: 'Backend Engineer',
        department: 'Delivery',
        date_of_joining: '2024-11-04',
        reports_to: 'arjun',
    },
    {
        key: 'sneha',
        email: 'sneha@viljetech.com',
        full_name: 'Sneha Patil',
        role: 'employee',
        employee_id: 'VT-007',
        job_title: 'QA Engineer',
        department: 'Engineering',
        date_of_joining: '2025-02-17',
        reports_to: 'priya',
    },
    {
        key: 'aditya',
        email: 'aditya@viljetech.com',
        full_name: 'Aditya Kulkarni',
        role: 'employee',
        employee_id: 'VT-008',
        job_title: 'DevOps Engineer',
        department: 'Delivery',
        date_of_joining: '2025-03-03',
        reports_to: 'arjun',
    },
    {
        key: 'ishita',
        email: 'ishita@viljetech.com',
        full_name: 'Ishita Banerjee',
        role: 'employee',
        employee_id: 'VT-009',
        job_title: 'Product Designer',
        department: 'Design',
        date_of_joining: '2025-04-14',
        reports_to: 'priya',
    },
    {
        key: 'karthik',
        email: 'karthik@viljetech.com',
        full_name: 'Karthik Menon',
        role: 'employee',
        employee_id: 'VT-010',
        job_title: 'Backend Engineer',
        department: 'Delivery',
        date_of_joining: '2024-12-09',
        reports_to: 'arjun',
    },
    // Company-level clients — each sees EVERY project of their company.
    {
        key: 'henrik',
        email: 'henrik@viljetech.com',
        full_name: 'Henrik Larsen',
        role: 'client',
        company: 'nordmark',
    },
    {
        key: 'emma',
        email: 'emma@viljetech.com',
        full_name: 'Emma Lindqvist',
        role: 'client',
        company: 'aurora',
    },
    // A representative — sees ONLY the projects they're rostered on. Seeded so
    // the demo actually exercises the difference between the two roles.
    {
        key: 'sofia',
        email: 'sofia@viljetech.com',
        full_name: 'Sofia Nordmark',
        role: 'representative',
        company: 'nordmark',
    },
];

const CLIENT_SIDE_ROLES = new Set(['client', 'representative']);
const INTERNAL_KEYS = USERS.filter((u) => !CLIENT_SIDE_ROLES.has(u.role)).map((u) => u.key);

interface TaskSpec {
    title: string;
    story: number; // index into project stories
    sprint: 1 | 2;
    assignee: string; // user key
    est: number;
    due: number; // offset in days from today
    status: 'to_do' | 'in_progress' | 'review' | 'done';
    priority: 'high' | 'medium' | 'low';
}

interface ProjectSpec {
    key: string;
    name: string;
    code: string;
    description: string;
    start_date: string;
    end_date: string;
    members: string[];
    clients: string[];
    stories: string[];
    tasks: TaskSpec[];
}

const PROJECTS: ProjectSpec[] = [
    {
        key: 'nfd',
        name: 'Nordmark Fleet Dashboard',
        code: 'NFD',
        description: 'Real-time fleet telemetry, route playback and depot operations dashboard for Nordmark Logistics.',
        start_date: '2026-02-02',
        end_date: '2026-09-30',
        members: ['kavya', 'ananya', 'vikram', 'aditya'],
        clients: ['henrik', 'sofia'],
        stories: [
            'Driver live-location view',
            'Route playback & history',
            'Fleet health alerts',
            'Depot check-in kiosk',
        ],
        tasks: [
            {
                title: 'Implement GPS polling fallback',
                story: 0,
                sprint: 1,
                assignee: 'vikram',
                est: 8,
                due: -10,
                status: 'done',
                priority: 'high',
            },
            {
                title: 'Driver marker clustering at low zoom',
                story: 0,
                sprint: 1,
                assignee: 'ananya',
                est: 6,
                due: -8,
                status: 'done',
                priority: 'medium',
            },
            {
                title: 'Live-location websocket reconnect logic',
                story: 0,
                sprint: 2,
                assignee: 'vikram',
                est: 8,
                due: 4,
                status: 'in_progress',
                priority: 'high',
            },
            {
                title: 'Route playback scrubber UI',
                story: 1,
                sprint: 2,
                assignee: 'ananya',
                est: 12,
                due: 7,
                status: 'in_progress',
                priority: 'medium',
            },
            {
                title: 'Trip history list with date filter',
                story: 1,
                sprint: 2,
                assignee: 'ananya',
                est: 6,
                due: 12,
                status: 'to_do',
                priority: 'low',
            },
            {
                title: 'Engine-fault alert webhook ingestion',
                story: 2,
                sprint: 2,
                assignee: 'vikram',
                est: 10,
                due: 2,
                status: 'review',
                priority: 'high',
            },
            {
                title: 'Alert severity triage rules',
                story: 2,
                sprint: 2,
                assignee: 'kavya',
                est: 4,
                due: 14,
                status: 'to_do',
                priority: 'medium',
            },
            {
                title: 'Depot kiosk QR check-in screen',
                story: 3,
                sprint: 2,
                assignee: 'ananya',
                est: 8,
                due: 18,
                status: 'to_do',
                priority: 'medium',
            },
            {
                title: 'Provision staging fleet simulator',
                story: 2,
                sprint: 1,
                assignee: 'aditya',
                est: 6,
                due: -12,
                status: 'done',
                priority: 'medium',
            },
            {
                title: 'CI pipeline for map tile cache',
                story: 3,
                sprint: 2,
                assignee: 'aditya',
                est: 4,
                due: 5,
                status: 'in_progress',
                priority: 'low',
            },
        ],
    },
    {
        key: 'afs',
        name: 'Aurora Foods Supply Portal',
        code: 'AFS',
        description: 'Supplier onboarding, invoice reconciliation and order tracking portal for Aurora Foods.',
        start_date: '2026-03-02',
        end_date: '2026-10-30',
        members: ['rohan', 'sneha', 'karthik', 'aditya'],
        clients: ['emma'],
        stories: ['Supplier onboarding wizard', 'Invoice reconciliation flow', 'Order tracking dashboard'],
        tasks: [
            {
                title: 'Add supplier KYC document upload',
                story: 0,
                sprint: 1,
                assignee: 'karthik',
                est: 10,
                due: -9,
                status: 'done',
                priority: 'high',
            },
            {
                title: 'Supplier onboarding step validation',
                story: 0,
                sprint: 2,
                assignee: 'karthik',
                est: 8,
                due: 3,
                status: 'in_progress',
                priority: 'high',
            },
            {
                title: 'Fix invoice rounding for SEK',
                story: 1,
                sprint: 1,
                assignee: 'rohan',
                est: 4,
                due: -11,
                status: 'done',
                priority: 'high',
            },
            {
                title: 'Invoice line-item matching engine',
                story: 1,
                sprint: 2,
                assignee: 'karthik',
                est: 16,
                due: 9,
                status: 'in_progress',
                priority: 'medium',
            },
            {
                title: 'Credit-note handling for partial returns',
                story: 1,
                sprint: 2,
                assignee: 'rohan',
                est: 8,
                due: 13,
                status: 'to_do',
                priority: 'medium',
            },
            {
                title: 'Order status timeline component',
                story: 2,
                sprint: 2,
                assignee: 'sneha',
                est: 6,
                due: 1,
                status: 'review',
                priority: 'medium',
            },
            {
                title: 'E2E tests for onboarding wizard',
                story: 0,
                sprint: 2,
                assignee: 'sneha',
                est: 8,
                due: 6,
                status: 'in_progress',
                priority: 'medium',
            },
            {
                title: 'Load test order search endpoint',
                story: 2,
                sprint: 1,
                assignee: 'sneha',
                est: 4,
                due: -7,
                status: 'done',
                priority: 'low',
            },
            {
                title: 'Dockerize supplier-portal service',
                story: 0,
                sprint: 1,
                assignee: 'aditya',
                est: 6,
                due: -13,
                status: 'done',
                priority: 'medium',
            },
            {
                title: 'Set up SFTP intake for legacy EDI orders',
                story: 2,
                sprint: 2,
                assignee: 'aditya',
                est: 12,
                due: 16,
                status: 'to_do',
                priority: 'low',
            },
        ],
    },
    {
        key: 'atlas',
        name: 'Atlas CRM Migration',
        code: 'ATLAS',
        description: 'Internal migration of the legacy CRM into Atlas — extraction, dedupe and cutover.',
        start_date: '2026-01-12',
        end_date: '2026-08-31',
        members: ['kavya', 'rohan', 'vikram', 'sneha', 'karthik'],
        clients: [],
        stories: ['Legacy data extraction', 'Contact dedupe & merge', 'Pipeline cutover runbook'],
        tasks: [
            {
                title: 'Export legacy CRM contacts to staging',
                story: 0,
                sprint: 1,
                assignee: 'rohan',
                est: 6,
                due: -14,
                status: 'done',
                priority: 'high',
            },
            {
                title: 'Map legacy fields to Atlas schema',
                story: 0,
                sprint: 1,
                assignee: 'vikram',
                est: 8,
                due: -10,
                status: 'done',
                priority: 'high',
            },
            {
                title: 'Incremental sync job for deltas',
                story: 0,
                sprint: 2,
                assignee: 'vikram',
                est: 12,
                due: 5,
                status: 'in_progress',
                priority: 'high',
            },
            {
                title: 'Fuzzy-match dedupe scoring',
                story: 1,
                sprint: 2,
                assignee: 'karthik',
                est: 16,
                due: 8,
                status: 'in_progress',
                priority: 'medium',
            },
            {
                title: 'Merge-conflict review UI',
                story: 1,
                sprint: 2,
                assignee: 'kavya',
                est: 10,
                due: 15,
                status: 'to_do',
                priority: 'medium',
            },
            {
                title: 'Dedupe dry-run report',
                story: 1,
                sprint: 2,
                assignee: 'sneha',
                est: 4,
                due: 2,
                status: 'review',
                priority: 'medium',
            },
            {
                title: 'Cutover rehearsal checklist',
                story: 2,
                sprint: 2,
                assignee: 'rohan',
                est: 4,
                due: 19,
                status: 'to_do',
                priority: 'low',
            },
            {
                title: 'Rollback plan for failed cutover',
                story: 2,
                sprint: 2,
                assignee: 'rohan',
                est: 6,
                due: 21,
                status: 'to_do',
                priority: 'medium',
            },
            {
                title: 'Validate migrated activity history',
                story: 0,
                sprint: 1,
                assignee: 'sneha',
                est: 6,
                due: -6,
                status: 'done',
                priority: 'medium',
            },
        ],
    },
    {
        key: 'web',
        name: 'Website Redesign 2026',
        code: 'WEB',
        description: 'Marketing site refresh — new brand system, case-study pages and a performance/SEO pass.',
        start_date: '2026-04-01',
        end_date: '2026-12-18',
        members: ['ishita', 'ananya', 'kavya'],
        clients: [],
        stories: ['Brand refresh & design tokens', 'Case-study pages', 'Performance & SEO pass'],
        tasks: [
            {
                title: 'New typography scale & token sheet',
                story: 0,
                sprint: 1,
                assignee: 'ishita',
                est: 8,
                due: -12,
                status: 'done',
                priority: 'high',
            },
            {
                title: 'Hero illustration set',
                story: 0,
                sprint: 1,
                assignee: 'ishita',
                est: 12,
                due: -8,
                status: 'done',
                priority: 'medium',
            },
            {
                title: 'Navigation redesign prototype',
                story: 0,
                sprint: 2,
                assignee: 'ishita',
                est: 6,
                due: 1,
                status: 'review',
                priority: 'high',
            },
            {
                title: 'Case-study template build',
                story: 1,
                sprint: 2,
                assignee: 'ananya',
                est: 10,
                due: 6,
                status: 'in_progress',
                priority: 'medium',
            },
            {
                title: 'Migrate 6 legacy case studies',
                story: 1,
                sprint: 2,
                assignee: 'ananya',
                est: 8,
                due: 14,
                status: 'to_do',
                priority: 'low',
            },
            {
                title: 'Image CDN + responsive srcset',
                story: 2,
                sprint: 2,
                assignee: 'kavya',
                est: 6,
                due: 4,
                status: 'in_progress',
                priority: 'medium',
            },
            {
                title: 'Lighthouse perf budget in CI',
                story: 2,
                sprint: 2,
                assignee: 'kavya',
                est: 4,
                due: 17,
                status: 'to_do',
                priority: 'low',
            },
            {
                title: 'Open Graph & meta overhaul',
                story: 2,
                sprint: 2,
                assignee: 'ishita',
                est: 2,
                due: -2,
                status: 'done',
                priority: 'low',
            },
        ],
    },
];

const HOURLY_RATES: Record<string, number> = {
    kavya: 85,
    rohan: 85,
    ananya: 60,
    vikram: 70,
    sneha: 55,
    aditya: 65,
    ishita: 60,
    karthik: 70,
    priya: 95,
    arjun: 95,
};

const HOLIDAYS: Array<{ date: string; name: string }> = [
    { date: '2026-08-15', name: 'Independence Day' },
    { date: '2026-10-02', name: 'Gandhi Jayanti' },
    { date: '2026-10-20', name: 'Diwali' },
    { date: '2026-12-25', name: 'Christmas Day' },
];

// Users who check in via API "this morning". The remaining two internal
// users (sneha, aditya) are deliberately left un-checked-in.
const CHECKIN_TODAY = ['priya', 'arjun', 'kavya', 'rohan', 'ananya', 'vikram', 'ishita', 'karthik'];
const CHECKIN_TIMES: Record<string, string> = {
    priya: '09:05',
    arjun: '09:32',
    kavya: '08:55',
    rohan: '09:48',
    ananya: '09:12',
    vikram: '10:10',
    ishita: '09:25',
    karthik: '09:58',
};

// ─── State accumulated during the run ──────────────────────────────────────

const userId: Record<string, string> = {}; // key → ObjectId string
const userToken: Record<string, string> = {}; // key → access token
const projectId: Record<string, string> = {};
const taskIdsByAssignee: Record<string, Array<{ task_id: string; project_id: string; title: string }>> = {};
const counts: Record<string, number> = {};
const quirks: string[] = [];
const bump = (k: string, n = 1) => {
    counts[k] = (counts[k] ?? 0) + n;
};

let adminToken = '';

// ─── Step 1: users ─────────────────────────────────────────────────────────

async function findUserIdByEmail(email: string): Promise<string | null> {
    const r = await api('GET', `/users?q=${encodeURIComponent(email)}&limit=5`, undefined, adminToken);
    const rows: any[] = r.body?.data ?? [];
    const hit = rows.find((u) => u.email === email);
    return hit ? idOf(hit) : null;
}

/**
 * Companies must exist before any client-side user, because
 * `client_profile.company_id` references one.
 */
/**
 * A project belongs to exactly ONE company. `p.clients` lists client-side user
 * keys; they must all belong to the same company (the BE's roster invariant
 * would reject a mix anyway), so the first one decides it. `null` = an
 * internal project with no client side.
 */
function companyOfProject(p: { clients: string[] }): string | null {
    for (const key of p.clients) {
        const spec = USERS.find((u) => u.key === key);
        if (spec?.company) return companyId[spec.company] ?? null;
    }
    return null;
}

async function seedCompanies(): Promise<void> {
    console.log('\n── Companies ──');
    for (const c of COMPANIES) {
        const r = await api('POST', '/companies', { name: c.name }, adminToken);
        if (r.status === 201) {
            companyId[c.key] = idOf(r.body.data);
            bump('companies_created');
            console.log(`  created ${c.name}`);
            continue;
        }
        if (r.status === 409) {
            // Name is unique case-insensitively — find the existing row.
            const list = await api('GET', `/companies?q=${encodeURIComponent(c.name)}`, undefined, adminToken);
            const hit = (list.body?.data ?? []).find(
                (row: any) => String(row.name).toLowerCase() === c.name.toLowerCase()
            );
            if (!hit) throw new Error(`company ${c.name} 409 but lookup failed`);
            companyId[c.key] = idOf(hit);
            console.log(`  exists  ${c.name}`);
            continue;
        }
        throw new Error(`company ${c.name} create failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
}

async function seedUsers(): Promise<void> {
    console.log('\n── Users ──');
    for (const u of USERS) {
        // A `representative` is NOT creatable via POST /users — that would
        // need `user.write`, the admin-wide bit. It goes through the scoped
        // company route, which derives the role and company server-side.
        if (u.role === 'representative') {
            const cid = companyId[u.company!];
            const rr = await api(
                'POST',
                `/companies/${cid}/representatives`,
                {
                    email: u.email,
                    full_name: u.full_name,
                    timezone: 'Asia/Kolkata',
                    initial_password: DEMO_PASSWORD,
                },
                adminToken
            );
            if (rr.status === 201) {
                userId[u.key] = idOf(rr.body.data);
                bump('users_created');
                console.log(`  created ${u.email} (representative)`);
            } else if (rr.status === 409) {
                const existing = await findUserIdByEmail(u.email);
                if (existing) userId[u.key] = existing;
                console.log(`  exists  ${u.email} (representative)`);
            } else {
                throw new Error(`representative ${u.email} failed: ${rr.status} ${JSON.stringify(rr.body)}`);
            }
            continue;
        }

        const body: any = {
            email: u.email,
            full_name: u.full_name,
            role: u.role,
            timezone: 'Asia/Kolkata',
            initial_password: DEMO_PASSWORD,
        };
        if (u.role === 'client') {
            body.client_profile = { company_id: companyId[u.company!], access_type: 'login' };
        } else {
            body.internal_profile = {
                employee_id: u.employee_id,
                job_title: u.job_title,
                department: u.department,
                date_of_joining: u.date_of_joining,
                ...(u.reports_to && userId[u.reports_to] ? { reporting_manager_id: userId[u.reports_to] } : {}),
            };
        }
        const r = await api('POST', '/users', body, adminToken);
        if (r.status === 201) {
            userId[u.key] = idOf(r.body.data);
            bump('users_created');
            console.log(`  created ${u.email} (${u.role})`);
        } else if (r.status === 409) {
            const existing = await findUserIdByEmail(u.email);
            if (!existing) throw new Error(`409 on ${u.email} but lookup failed`);
            userId[u.key] = existing;
            console.log(`  exists  ${u.email} (reusing)`);
        } else {
            throw new Error(`create user ${u.email} failed (${r.status}): ${JSON.stringify(r.body)}`);
        }
    }

    // Leave balances for the demo year (idempotent upsert per user × type).
    must(
        await api('POST', '/leave-balances/initialize-year', { year: Number(TODAY.slice(0, 4)) }, adminToken),
        'initialize-year'
    );
    console.log(`  initialized leave balances for ${TODAY.slice(0, 4)}`);

    for (const key of INTERNAL_KEYS) {
        const spec = USERS.find((u) => u.key === key)!;
        userToken[key] = await login(spec.email, DEMO_PASSWORD);
    }
    console.log(`  logged in ${INTERNAL_KEYS.length} internal users`);
}

// ─── Step 2: projects / sprints / stories / tasks ──────────────────────────

async function seedProjects(): Promise<void> {
    console.log('\n── Projects ──');
    const sprint1 = { start: '2026-05-18', end: '2026-05-29' };
    const sprint2Start = addDays(TODAY, -11);
    const sprint2End = addDays(TODAY, 10);

    for (const p of PROJECTS) {
        const createRes = await api(
            'POST',
            '/projects',
            {
                name: p.name,
                code: p.code,
                description: p.description,
                start_date: p.start_date,
                end_date: p.end_date,
                status: 'active',
                member_ids: p.members.map((m) => userId[m]),
                // One company per project. `p.clients` lists client-side user
                // keys; the project's company is theirs. Company-level clients
                // are auto-rostered by the service, so only representatives
                // need listing explicitly.
                company_id: companyOfProject(p),
                representative_ids: p.clients
                    .filter((c) => USERS.find((u) => u.key === c)?.role === 'representative')
                    .map((c) => userId[c]),
            },
            adminToken
        );

        if (createRes.status === 409) {
            const list = await api('GET', `/projects?q=${encodeURIComponent(p.code)}`, undefined, adminToken);
            const hit = (list.body?.data ?? []).find((row: any) => row.code === p.code);
            if (!hit) throw new Error(`project ${p.code} 409 but lookup failed`);
            projectId[p.key] = idOf(hit);
            console.log(`  exists  ${p.code} — skipping sprints/stories/tasks for it`);
            continue;
        }
        const proj = must(createRes, `create project ${p.code}`);
        projectId[p.key] = idOf(proj);
        bump('projects');

        // Sprints
        const s1 = must(
            await api(
                'POST',
                `/projects/${projectId[p.key]}/sprints`,
                {
                    name: 'Sprint 1',
                    goal: `${p.code} foundation work`,
                    start_date: sprint1.start,
                    end_date: sprint1.end,
                    status: 'completed',
                },
                adminToken
            ),
            `${p.code} sprint 1`
        );
        const s2 = must(
            await api(
                'POST',
                `/projects/${projectId[p.key]}/sprints`,
                {
                    name: 'Sprint 2',
                    goal: `${p.code} feature build-out`,
                    start_date: sprint2Start,
                    end_date: sprint2End,
                    status: 'active',
                },
                adminToken
            ),
            `${p.code} sprint 2`
        );
        bump('sprints', 2);
        const sprintIds = { 1: idOf(s1), 2: idOf(s2) } as const;

        // Stories
        const storyIds: string[] = [];
        for (const title of p.stories) {
            const st = must(
                await api(
                    'POST',
                    `/projects/${projectId[p.key]}/stories`,
                    {
                        title,
                        description: `${title} — ${p.name}`,
                    },
                    adminToken
                ),
                `${p.code} story "${title}"`
            );
            storyIds.push(idOf(st));
            bump('stories');
        }

        // Tasks — create (status defaults to to_do), then PATCH to target status.
        for (const t of p.tasks) {
            const created = must(
                await api(
                    'POST',
                    '/tasks',
                    {
                        project_id: projectId[p.key],
                        sprint_id: sprintIds[t.sprint],
                        story_id: storyIds[t.story],
                        title: t.title,
                        description: `${t.title} (${p.name})`,
                        priority: t.priority,
                        due_date: addDays(TODAY, t.due),
                        estimated_hours: t.est,
                        primary_assignee_id: userId[t.assignee],
                    },
                    adminToken
                ),
                `${p.code} task "${t.title}"`
            );
            const tid = idOf(created);
            bump('tasks');

            if (t.status !== 'to_do') {
                must(
                    await api('PATCH', `/tasks/${tid}`, { status: t.status }, adminToken),
                    `move "${t.title}" → ${t.status}`
                );
            }
            (taskIdsByAssignee[t.assignee] ??= []).push({ task_id: tid, project_id: projectId[p.key], title: t.title });
        }
        console.log(`  ${p.code}: ${p.stories.length} stories, ${p.tasks.length} tasks`);
    }
}

// ─── Step 3: billing rates ─────────────────────────────────────────────────

async function seedBillingRates(): Promise<void> {
    console.log('\n── Billing rates ──');
    // Re-POSTing an existing (user × project) rate would auto-close the old
    // row and open a new one (forward-extension invariant) — so prefetch and
    // skip pairs that already have a rate.
    const existingPairs = new Set<string>();
    for (let page = 1; ; page += 1) {
        const res = await api('GET', `/billing-rates?limit=100&page=${page}`, undefined, adminToken);
        const rows = must(res, `list billing rates page ${page}`) as any[];
        for (const row of rows) existingPairs.add(`${row.user_id}|${row.project_id}`);
        if (rows.length < 100) break;
    }
    for (const p of PROJECTS) {
        for (const m of p.members) {
            if (existingPairs.has(`${userId[m]}|${projectId[p.key]}`)) {
                console.log(`  rate exists for ${m} × ${p.code} (skipping)`);
                continue;
            }
            const r = await api(
                'POST',
                '/billing-rates',
                {
                    user_id: userId[m],
                    project_id: projectId[p.key],
                    hourly_rate: HOURLY_RATES[m] ?? 60,
                    effective_from: '2026-01-01',
                },
                adminToken
            );
            if (r.status === 201) bump('billing_rates');
            else if (r.status === 409) console.log(`  rate exists for ${m} × ${p.code}`);
            else throw new Error(`billing rate ${m} × ${p.code} failed (${r.status}): ${JSON.stringify(r.body)}`);
        }
    }
    console.log(`  created ${counts.billing_rates ?? 0} rates`);
}

// ─── Step 4: timesheets ────────────────────────────────────────────────────

async function seedTimesheets(): Promise<void> {
    console.log('\n── Timesheets (last 5 working days + today) ──');
    // POST /timesheets has no natural uniqueness — a re-run would duplicate
    // every entry. Skip the whole phase when any entry already exists.
    const existing = await listTotal('/timesheets?limit=1', adminToken);
    if (existing > 0) {
        console.log(`  ${existing} entries already exist — skipping phase`);
        return;
    }
    const days = [...workingDaysBefore(TODAY, 5), TODAY];

    for (const key of INTERNAL_KEYS) {
        const token = userToken[key]!;
        const myTasks = taskIdsByAssignee[key] ?? [];
        let entries = 0;

        for (let di = 0; di < days.length; di += 1) {
            const date = days[di]!;
            if (myTasks.length >= 2) {
                // Two task-linked entries, mostly billable.
                const t1 = myTasks[di % myTasks.length]!;
                const t2 = myTasks[(di + 1) % myTasks.length]!;
                const h1 = 3 + (di % 2); // 3–4h
                const h2 = 3;
                const r1 = await api(
                    'POST',
                    '/timesheets',
                    {
                        local_date: date,
                        entry_type: 'task_linked',
                        project_id: t1.project_id,
                        task_id: t1.task_id,
                        billable_hours: h1,
                        billable_minutes: di % 2 ? 30 : 0,
                        non_billable_hours: 0,
                        non_billable_minutes: 0,
                        description: `Worked on ${t1.title}`,
                    },
                    token
                );
                const r2 = await api(
                    'POST',
                    '/timesheets',
                    {
                        local_date: date,
                        entry_type: 'task_linked',
                        project_id: t2.project_id,
                        task_id: t2.task_id,
                        billable_hours: h2 - 1,
                        billable_minutes: 30,
                        non_billable_hours: 1,
                        non_billable_minutes: 0,
                        description: `Progress on ${t2.title}`,
                    },
                    token
                );
                if (r1.status === 201) entries += 1;
                else quirks.push(`timesheet ${key} ${date} #1 → ${r1.status}`);
                if (r2.status === 201) entries += 1;
                else quirks.push(`timesheet ${key} ${date} #2 → ${r2.status}`);
            } else {
                // Managers (no assigned tasks): general entries.
                const r1 = await api(
                    'POST',
                    '/timesheets',
                    {
                        local_date: date,
                        entry_type: 'general',
                        general_category: 'Project management',
                        billable_hours: 3,
                        billable_minutes: 0,
                        non_billable_hours: 1,
                        non_billable_minutes: 0,
                        description: 'Sprint coordination, standups and delivery reviews',
                    },
                    token
                );
                const r2 = await api(
                    'POST',
                    '/timesheets',
                    {
                        local_date: date,
                        entry_type: 'general',
                        general_category: 'Planning & 1:1s',
                        billable_hours: 2,
                        billable_minutes: 30,
                        non_billable_hours: 0,
                        non_billable_minutes: 30,
                        description: 'Roadmap planning and team 1:1s',
                    },
                    token
                );
                if (r1.status === 201) entries += 1;
                else quirks.push(`timesheet ${key} ${date} #1 → ${r1.status}`);
                if (r2.status === 201) entries += 1;
                else quirks.push(`timesheet ${key} ${date} #2 → ${r2.status}`);
            }
        }
        bump('timesheet_entries', entries);
        console.log(`  ${key}: ${entries} entries`);
    }
}

// ─── Step 5: engagements + invoices ────────────────────────────────────────
//
// Phase 1 "Client Engagements & Invoicing" (docs/superpowers/specs/2026-07-24-
// billing-invoicing-design.md). Runs after billing rates + timesheets so the
// generated invoices' `hours` lines resolve real rates against real seeded
// timesheet minutes, exactly like a live demo would. Idempotent by `name`
// (engagements) / `engagement_id` (invoices) so re-running the seed against a
// non-wiped DB just skips what already exists.

async function seedEngagements(): Promise<void> {
    console.log('\n── Engagements + invoices ──');

    const periodDays = [...workingDaysBefore(TODAY, 5), TODAY];
    const periodStart = periodDays[0]!;
    const periodEnd = TODAY;

    const engagementSpecs: Array<{ key: string; body: Record<string, unknown>; sendInvoice: boolean }> = [
        {
            key: 'aurora-retainer',
            body: {
                company_id: companyId.aurora,
                project_ids: [projectId.afs],
                name: 'Aurora Foods — 2026 Retainer',
                currency: 'EUR',
                billing_type: 'retainer',
                setup_fee: 1500,
                retainer_amount: 8000,
                retainer_period: 'month',
                included_hours: 40,
                start_date: '2026-03-02',
                notes: 'Monthly retainer covering the Aurora Foods Supply Portal build.',
            },
            sendInvoice: true,
        },
        {
            key: 'nordmark-hourly',
            body: {
                company_id: companyId.nordmark,
                project_ids: [projectId.nfd],
                name: 'Nordmark Fleet Dashboard — Hourly',
                currency: 'NOK',
                billing_type: 'hourly',
                start_date: '2026-02-02',
                notes: 'Hourly billing against the Fleet Dashboard build (billing-rate driven).',
            },
            sendInvoice: false,
        },
    ];

    for (const spec of engagementSpecs) {
        const existing = must(
            await api('GET', `/engagements?company_id=${spec.body.company_id}&limit=50`, undefined, adminToken),
            `list engagements for ${spec.key}`
        ) as any[];
        const already = existing.find((e) => e.name === spec.body.name);

        let engagementId: string;
        if (already) {
            console.log(`  engagement "${spec.body.name as string}" already exists — skipping create`);
            engagementId = idOf(already);
        } else {
            const r = await api('POST', '/engagements', spec.body, adminToken);
            if (r.status !== 201) {
                quirks.push(`engagement ${spec.key} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 200)}`);
                continue;
            }
            engagementId = idOf(r.body?.data);
            bump('engagements');
            console.log(`  created engagement "${spec.body.name as string}"`);
        }

        // Idempotency for the invoice half: skip generate if this engagement
        // already has an invoice (from a prior run against a non-wiped DB).
        const existingInvoices = must(
            await api('GET', `/invoices?engagement_id=${engagementId}&limit=50`, undefined, adminToken),
            `list invoices for ${spec.key}`
        ) as any[];
        if (existingInvoices.length > 0) {
            console.log(`  invoice(s) already exist for "${spec.body.name as string}" — skipping generate`);
            continue;
        }

        const genRes = await api(
            'POST',
            '/invoices/generate',
            { engagement_id: engagementId, period_start: periodStart, period_end: periodEnd },
            adminToken
        );
        if (genRes.status !== 201) {
            quirks.push(
                `invoice generate ${spec.key} → ${genRes.status}: ${JSON.stringify(genRes.body)?.slice(0, 200)}`
            );
            continue;
        }
        const invoice = genRes.body?.data;
        bump('invoices');
        console.log(`  generated invoice ${invoice.number} for "${spec.body.name as string}" (${invoice.status})`);

        if (spec.sendInvoice) {
            const sendRes = await api('POST', `/invoices/${idOf(invoice)}/status`, { to: 'sent' }, adminToken);
            if (sendRes.status === 200) {
                console.log(`  marked ${invoice.number} as sent`);
            } else {
                quirks.push(
                    `invoice send ${spec.key} → ${sendRes.status}: ${JSON.stringify(sendRes.body)?.slice(0, 200)}`
                );
            }
        }
    }
}

// ─── Step 5.5: cost rates + FX (Billing Phase 2 — Cost Rates & Margin) ─────
//
// Cost-side twin of `seedBillingRates` — same INR-flat-rate simplification,
// same "prefetch existing + skip" idempotency (a cost rate is unique per
// `(user_id, effective_from)`, so re-POSTing the same pair on a re-run
// would either 409 or, worse, silently auto-close/extend). Mirrors exactly
// the staff `seedBillingRates`/`seedTimesheets` already covers (`HOURLY_RATES`
// keys) so the Margin report has both a bill rate AND a cost rate — and
// therefore real, non-zero numbers — for every billable user out of the box.
//
// Also seeds `SystemSettings.billing.reporting_currency = 'INR'` (already
// the schema default, set explicitly here for clarity) + `fx_rates` for
// EUR and NOK — the two non-INR currencies `seedEngagements` uses (Aurora
// retainer = EUR, Nordmark hourly = NOK) — so the demo Margin report shows
// zero "No FX rate" warnings out of the box. Runs AFTER `seedBillingRates`
// (references the same users) and AFTER `seedEngagements` (so the FX rates
// it needs are known) though neither is a hard dependency.

const COST_RATES_INR: Record<string, number> = {
    kavya: 650,
    rohan: 650,
    ananya: 450,
    vikram: 500,
    sneha: 400,
    aditya: 480,
    ishita: 450,
    karthik: 500,
    priya: 700,
    arjun: 700,
};

const COST_RATE_EFFECTIVE_FROM = '2026-01-01'; // matches seedBillingRates

async function seedCostRatesAndFx(): Promise<void> {
    console.log('\n── Cost rates + FX ──');

    // Prefetch existing cost rates so a re-run against a non-wiped DB skips
    // users who already have one, rather than 409-ing or (for a later
    // effective_from) silently auto-closing/extending a real admin-entered
    // rate.
    const existingUserIds = new Set<string>();
    for (let page = 1; ; page += 1) {
        const res = await api('GET', `/cost-rates?limit=100&page=${page}`, undefined, adminToken);
        const rows = must(res, `list cost rates page ${page}`) as any[];
        for (const row of rows) existingUserIds.add(String(row.user_id));
        if (rows.length < 100) break;
    }

    for (const [key, cost_per_hour] of Object.entries(COST_RATES_INR)) {
        const uid = userId[key];
        if (!uid) continue; // defensive — USERS list changed underneath us
        if (existingUserIds.has(uid)) {
            console.log(`  cost rate exists for ${key} (skipping)`);
            continue;
        }
        const r = await api(
            'POST',
            '/cost-rates',
            {
                user_id: uid,
                cost_per_hour,
                currency: 'INR',
                effective_from: COST_RATE_EFFECTIVE_FROM,
            },
            adminToken
        );
        if (r.status === 201) bump('cost_rates');
        else if (r.status === 409) console.log(`  cost rate exists for ${key}`);
        else throw new Error(`cost rate ${key} failed (${r.status}): ${JSON.stringify(r.body)}`);
    }
    console.log(`  created ${counts.cost_rates ?? 0} cost rates`);

    // Reporting currency + FX — deep-merge PATCH, so this only ever adds to
    // (never removes) whatever an admin already configured. Skips the PATCH
    // entirely once INR/EUR/NOK are all present, so a re-run is a no-op.
    const settingsRes = must(await api('GET', '/settings', undefined, adminToken), 'get settings');
    const currentFxRates: Array<{ currency: string; rate_to_base: number }> = settingsRes?.billing?.fx_rates ?? [];
    const currentReportingCurrency: string = settingsRes?.billing?.reporting_currency ?? 'INR';

    const wantFx: Record<string, number> = { EUR: 90, NOK: 8 };
    const haveCurrencies = new Set(currentFxRates.map((r) => r.currency.toUpperCase()));
    const missing = Object.entries(wantFx).filter(([ccy]) => !haveCurrencies.has(ccy));

    if (currentReportingCurrency === 'INR' && missing.length === 0) {
        console.log('  reporting_currency + fx_rates already cover EUR/NOK — skipping settings patch');
    } else {
        const mergedFxRates = [
            ...currentFxRates,
            ...missing.map(([currency, rate_to_base]) => ({ currency, rate_to_base })),
        ];
        const patchRes = await api(
            'PATCH',
            '/settings',
            { billing: { reporting_currency: 'INR', fx_rates: mergedFxRates } },
            adminToken
        );
        if (patchRes.status !== 200) {
            throw new Error(`settings billing FX patch failed (${patchRes.status}): ${JSON.stringify(patchRes.body)}`);
        }
        console.log(`  reporting_currency=INR, fx_rates=[${mergedFxRates.map((r) => r.currency).join(', ')}]`);
    }
}

// ─── Step 6: attendance today (API) ────────────────────────────────────────

async function seedAttendanceToday(): Promise<void> {
    console.log('\n── Attendance (today, via API) ──');
    for (const key of CHECKIN_TODAY) {
        const r = await api('POST', '/attendance/check-in', { method: 'manual' }, userToken[key]);
        if (r.status === 200 || r.status === 201) {
            bump('checkins_today');
            console.log(`  checked in ${key}`);
        } else if (r.status === 409) {
            console.log(`  ${key} already checked in`);
        } else {
            quirks.push(`check-in ${key} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 200)}`);
        }
    }
    console.log('  (sneha, aditya left not-checked-in on purpose — aditya is on same-day SL)');
}

// ─── Step 7: leaves ────────────────────────────────────────────────────────

async function seedLeaves(): Promise<void> {
    console.log('\n── Leaves ──');
    // Leave applies aren't idempotent (a re-run would double-book balances).
    // Skip the whole phase when any request already exists.
    const existingLeaves = await listTotal('/leaves?limit=1', adminToken);
    if (existingLeaves > 0) {
        console.log(`  ${existingLeaves} leave requests already exist — skipping phase`);
        return;
    }
    const types = must(await api('GET', '/leave-types', undefined, adminToken), 'list leave types') as any[];
    const byCode = (code: string) => {
        const t = types.find((x) => x.code === code);
        if (!t) throw new Error(`leave type ${code} not found`);
        return idOf(t);
    };
    const CL = byCode('CL');
    const SL = byCode('SL');

    // CL requires 14 days advance notice (hard validation) — anchor all CL
    // requests on/after today+14.
    const clEarliest = addDays(TODAY, 14);
    const ananyaStart = nextMondayOnOrAfter(clEarliest); // Mon
    const ananyaEnd = addDays(ananyaStart, 1); // Tue
    const karthikDay = nextWorkingDayOnOrAfter(clEarliest);
    const snehaStart = addDays(ananyaStart, 2); // Wed of that week
    const snehaEnd = addDays(snehaStart, 2); // Wed–Fri

    const apply = async (who: string, body: any, label: string): Promise<string | null> => {
        const r = await api('POST', '/leaves', body, userToken[who]);
        if (r.status === 201 || r.status === 200) {
            bump('leave_requests');
            console.log(`  ${label}: applied ${body.start_date}..${body.end_date}`);
            return idOf(r.body.data);
        }
        quirks.push(`leave ${label} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 300)}`);
        return null;
    };

    const ananyaLeave = await apply(
        'ananya',
        {
            leave_type_id: CL,
            start_date: ananyaStart,
            end_date: ananyaEnd,
            reason: 'Family function in Kochi',
        },
        'Ananya CL 2d'
    );

    const karthikLeave = await apply(
        'karthik',
        {
            leave_type_id: CL,
            start_date: karthikDay,
            end_date: karthikDay,
            reason: 'Personal errand — bank and registration work',
        },
        'Karthik CL 1d'
    );

    // Aditya sick leave — TODAY, then approved. This is the row that makes
    // the admin-analytics `leave_mix` section non-empty: that section only
    // counts approved leaves with start_date inside [range.from, range.to]
    // (month-to-date), backdated applies are rejected by the API, and CL's
    // 14-day advance notice pushes every other approved leave past `to`.
    // Narrative bonus: aditya is deliberately NOT in CHECKIN_TODAY.
    const adityaLeave = isWeekend(TODAY)
        ? null
        : await apply(
              'aditya',
              {
                  leave_type_id: SL,
                  start_date: TODAY,
                  end_date: TODAY,
                  reason: 'Migraine — taking the day off',
              },
              'Aditya SL today'
          );
    if (isWeekend(TODAY)) quirks.push('today is a weekend — skipped the Aditya same-day SL (leave_mix may be empty)');

    // Vikram sick leave — "tomorrow", shifted to the next working day when
    // tomorrow lands on a weekend (the engine excludes weekend days).
    const vikramDay = nextWorkingDayOnOrAfter(addDays(TODAY, 1));
    if (vikramDay !== addDays(TODAY, 1)) {
        quirks.push(`Vikram SL: tomorrow (${addDays(TODAY, 1)}) is a weekend — used ${vikramDay} instead`);
    }
    await apply(
        'vikram',
        {
            leave_type_id: SL,
            start_date: vikramDay,
            end_date: vikramDay,
            reason: 'Fever and cold — resting at home',
        },
        'Vikram SL 1d (stays pending)'
    );

    await apply(
        'sneha',
        {
            leave_type_id: CL,
            start_date: snehaStart,
            end_date: snehaEnd,
            reason: 'Travelling to Pune for a family event',
        },
        'Sneha CL 3d (stays pending)'
    );

    for (const [id, label] of [
        [ananyaLeave, 'Ananya'],
        [karthikLeave, 'Karthik'],
        [adityaLeave, 'Aditya'],
    ] as const) {
        if (!id) continue;
        const r = await api(
            'POST',
            `/leaves/${id}/approve`,
            { approver_remarks: 'Approved — plan handover before you go.' },
            adminToken
        );
        if (r.status === 200) {
            bump('leaves_approved');
            console.log(`  approved ${label}'s leave`);
        } else {
            quirks.push(`approve ${label} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 300)}`);
        }
    }
}

// ─── Step 8: comp-off ──────────────────────────────────────────────────────

async function seedCompOff(): Promise<void> {
    console.log('\n── Comp-off ──');
    // Adjustments aren't idempotent — skip when any ledger row exists.
    const existing = await listTotal('/comp-off?limit=1', adminToken);
    if (existing > 0) {
        console.log(`  ${existing} ledger rows already exist — skipping phase`);
        return;
    }
    const grants = [
        { who: 'vikram', days: 1, remarks: 'Weekend release support' }, // 480 min
        { who: 'kavya', days: 0.5, remarks: 'Production hotfix Saturday' }, // 240 min
    ];
    for (const g of grants) {
        const r = await api(
            'POST',
            '/comp-off/adjust',
            {
                user_id: userId[g.who],
                type: 'earned',
                days: g.days,
                remarks: g.remarks,
            },
            adminToken
        );
        if (r.status === 200 || r.status === 201) {
            bump('comp_off_grants');
            console.log(`  ${g.who}: +${g.days}d (${g.remarks})`);
        } else {
            quirks.push(`comp-off ${g.who} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 200)}`);
        }
    }
}

// ─── Step 9: holidays ──────────────────────────────────────────────────────

async function seedHolidays(): Promise<void> {
    console.log('\n── Holidays ──');
    for (const h of HOLIDAYS) {
        const r = await api('POST', '/holidays', { date: h.date, name: h.name, type: 'public' }, adminToken);
        if (r.status === 201) {
            bump('holidays');
            console.log(`  ${h.date} ${h.name}`);
        } else if (r.status === 409) console.log(`  ${h.date} already exists`);
        else quirks.push(`holiday ${h.date} → ${r.status}: ${JSON.stringify(r.body)?.slice(0, 200)}`);
    }
}

// ─── Step 10: attendance history + today's time variation (direct Mongo) ──

async function seedAttendanceHistory(): Promise<void> {
    console.log('\n── Attendance history (direct Mongo) ──');
    await connectDB();
    assertSafeDb('demo-seed.ts');
    const db = mongoose.connection.db!;
    const col = db.collection(COLLECTIONS.ATTENDANCE_RECORDS);

    // 9a — vary today's check-in times (the API stamps "now").
    for (const key of CHECKIN_TODAY) {
        const t = istInstant(TODAY, CHECKIN_TIMES[key] ?? '09:30');
        await col.updateOne(
            { user_id: new mongoose.Types.ObjectId(userId[key]), local_date: TODAY },
            { $set: { 'check_in.time': t, 'segments.0.check_in.time': t } }
        );
    }
    console.log("  varied today's check-in times (08:55–10:10 IST)");

    // 9b — past 10 working days, all internal users, present with full day.
    const days = workingDaysBefore(TODAY, 10);
    const inTimes = ['09:00', '09:05', '09:12', '09:18', '09:25', '09:30', '09:34', '09:40', '09:43', '09:45'];
    const outTimes = ['18:00', '18:10', '18:20', '18:25', '18:30', '18:40', '18:45', '18:50', '18:55', '19:00'];
    let inserted = 0;

    for (const key of INTERNAL_KEYS) {
        const uid = new mongoose.Types.ObjectId(userId[key]);
        for (const day of days) {
            const checkInAt = istInstant(day, pick(inTimes));
            const checkOutAt = istInstant(day, pick(outTimes));
            const totalMin = Math.round((checkOutAt.getTime() - checkInAt.getTime()) / 60000);
            const punchIn = { time: checkInAt, method: 'manual', location_id: null, ip: '' };
            const punchOut = { time: checkOutAt, method: 'manual', location_id: null, ip: '' };
            const now = new Date();

            const res = await col.updateOne(
                { user_id: uid, local_date: day },
                {
                    $setOnInsert: {
                        user_id: uid,
                        local_date: day,
                        segments: [{ check_in: punchIn, check_out: punchOut }],
                        check_in: punchIn,
                        check_out: punchOut,
                        total_worked_minutes: totalMin,
                        overtime_minutes: 0,
                        status: 'present',
                        flagged_for_correction: false,
                        wfh: false,
                        notes: '',
                        last_corrected_by: null,
                        last_corrected_at: null,
                        created_at: now,
                        updated_at: now,
                    },
                },
                { upsert: true }
            );
            if (res.upsertedCount) inserted += 1;
        }
    }
    bump('attendance_history_rows', inserted);
    console.log(`  inserted ${inserted} historical attendance rows (${days[0]} → ${days[days.length - 1]})`);

    await disconnectDB();
}

// ─── Step 11: verification ─────────────────────────────────────────────────

async function verify(): Promise<void> {
    console.log('\n── Verification ──');
    let failures = 0;
    const expect = (cond: boolean, label: string) => {
        console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`);
        if (!cond) failures += 1;
    };

    // Admin analytics — all five sections present with non-empty data.
    const analytics = must(
        await api('GET', '/dashboard/admin/analytics?range=month', undefined, adminToken),
        'admin analytics'
    );
    const sections = analytics?.sections ?? {};
    for (const name of ['kpi', 'attendance_trend', 'leave_mix', 'hours_by_project', 'tasks_by_status']) {
        const s = sections[name];
        const nonEmpty =
            s !== undefined &&
            s !== null &&
            (Array.isArray(s)
                ? s.length > 0
                : Array.isArray(s?.data)
                  ? s.data.length > 0
                  : Array.isArray(s?.points)
                    ? s.points.length > 0
                    : typeof s === 'object'
                      ? Object.keys(s).length > 0
                      : true);
        expect(nonEmpty, `analytics section "${name}" present + non-empty`);
    }

    // Projects — task counts.
    const projects = must(await api('GET', '/projects?limit=50', undefined, adminToken), 'list projects') as any[];
    expect(projects.length === PROJECTS.length, `project count == ${PROJECTS.length} (got ${projects.length})`);
    for (const p of projects) {
        const done = p.done_task_count ?? 0;
        const total = p.task_count ?? 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        expect(total > 0, `${p.code}: task_count > 0 (${total})`);
        expect(done > 0 && done < total, `${p.code}: done sensible (${done}/${total} = ${pct}%)`);
    }

    // Analytics — demo-critical values.
    const kpi = sections.kpi ?? {};
    expect((kpi.billable_value?.value ?? 0) > 0, `kpi.billable_value > 0 (got ${kpi.billable_value?.value})`);
    const trendDays = (sections.attendance_trend?.data ?? []) as Array<{ present: number }>;
    const presentDays = trendDays.filter((d) => d.present > 0).length;
    expect(presentDays > 0, `attendance_trend has non-zero present days (got ${presentDays})`);
    const upcoming = (sections.upcoming_leaves?.data ?? []) as any[];
    expect(upcoming.length >= 1, `upcoming_leaves >= 1 (got ${upcoming.length})`);

    // Admin dashboard — pending approvals + attendance today.
    const adminDash = must(await api('GET', '/dashboard/admin', undefined, adminToken), 'admin dashboard');
    const pendingCount = adminDash?.pending_leave_approvals?.count ?? -1;
    expect(pendingCount === 2, `dashboard pending_leave_approvals.count == 2 (got ${pendingCount})`);
    const presentToday = adminDash?.attendance_today?.present ?? -1;
    expect(presentToday >= 6, `dashboard attendance_today.present >= 6 (got ${presentToday})`);

    // Holidays — 4 seeded for 2026.
    const holidayRows = must(
        await api('GET', `/holidays?year=${TODAY.slice(0, 4)}`, undefined, adminToken),
        'list holidays'
    ) as any[];
    expect(holidayRows.length === HOLIDAYS.length, `holidays == ${HOLIDAYS.length} (got ${holidayRows.length})`);

    // Pending approvals.
    const pendingRes = await api('GET', '/leaves?status=pending&limit=50', undefined, adminToken);
    const pending = (pendingRes.body?.data ?? []) as any[];
    expect(pending.length === 2, `pending leave approvals == 2 (got ${pending.length})`);

    // Summary table.
    console.log('\n── Seeded entity summary ──');
    const pad = (s: string, n: number) => s.padEnd(n);
    for (const [k, v] of Object.entries(counts)) console.log(`  ${pad(k, 28)}${v}`);

    if (quirks.length) {
        console.log('\n── Quirks / notes ──');
        for (const q of quirks) console.log(`  - ${q}`);
    }

    console.log(`\n${failures === 0 ? 'ALL VERIFICATIONS PASSED' : `${failures} VERIFICATION(S) FAILED`}`);
    if (failures > 0) process.exitCode = 1;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.log(`Demo seed starting — today (IST) = ${TODAY}`);
    adminToken = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

    await seedCompanies();
    await seedUsers();
    await seedProjects();
    await seedBillingRates();
    await seedTimesheets();
    await seedEngagements();
    await seedCostRatesAndFx();
    await seedAttendanceToday();
    await seedLeaves();
    await seedCompOff();
    await seedHolidays();
    await seedAttendanceHistory();
    await verify();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
