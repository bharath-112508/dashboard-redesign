/**
 * Migration — free-text `client_profile.company_name` → first-class `companies`.
 *
 * Vocabulary: **"Client" IS the company** (the company-level role);
 * a **"Representative"** is that company's project-scoped person.
 *
 * DRY-RUN BY DEFAULT. Prints the full plan and writes nothing.
 * Pass `--commit` to apply.
 *
 *   npx tsx scripts/migrate-companies.ts             # plan only
 *   npx tsx scripts/migrate-companies.ts --commit    # apply
 *
 * What it does:
 *   1. Groups `client` users by trimmed + case-folded `company_name`.
 *   2. Creates one Company per distinct name.
 *   3. Sets each client's `client_profile.company_id`; unsets `company_name`
 *      and `point_of_contact`. **Role is unchanged** — an existing `client`
 *      stays a `client` and simply becomes company-level. Nobody gains a
 *      permission they didn't already have.
 *   4. Per project: derives `company_id` from its `client_ids`' companies,
 *      sets `representative_ids = client_ids`, unsets `client_ids`.
 *   5. Reconciles the roster: adds each company's `client`s to every project
 *      of that company (the denormalised roster invariant).
 *
 * Two things to read the plan for:
 *
 *   MERGES — grouping is case-insensitive, so "TCS" and "TCS " collapse into
 *   one company. That's right if they're the same company and wrong if they
 *   aren't, and only a human can tell. Every merge is listed.
 *
 *   MULTI-COMPANY PROJECTS — a project shared with clients from >1 company
 *   cannot migrate cleanly under one-company-per-project. Rule: pick the
 *   company with the most reps on that project (tie → earliest-created
 *   client). Every dropped rep is named, because they LOSE ACCESS to that
 *   project.
 *
 * Re-runnable: it matches on the legacy `client_ids` field, which it removes,
 * and skips clients that already carry a `company_id`. A second run is a
 * clean no-op, so re-running after a partial failure is safe.
 */
import mongoose from 'mongoose';

import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { COLLECTIONS } from '../src/constants/collections.js';
import { ROLES } from '../src/constants/roles.js';

const COMMIT = process.argv.includes('--commit');

interface ClientUser {
    _id: mongoose.Types.ObjectId;
    full_name: string;
    email: string;
    role: string;
    created_at?: Date;
    client_profile?: {
        company_name?: string;
        point_of_contact?: string;
        company_id?: mongoose.Types.ObjectId;
    };
}

interface LegacyProject {
    _id: mongoose.Types.ObjectId;
    name: string;
    code: string;
    client_ids?: mongoose.Types.ObjectId[];
}

/** Grouping key — trimmed + case-folded, matching the collated unique index. */
const groupKey = (name: string): string => name.trim().toLowerCase();

const log = (...args: unknown[]): void => console.log(...args);

const run = async (): Promise<void> => {
    await connectDB();
    const db = mongoose.connection.db;
    if (!db) throw new Error('No database handle');

    const users = db.collection(COLLECTIONS.USERS);
    const projects = db.collection(COLLECTIONS.PROJECTS);
    const companies = db.collection(COLLECTIONS.COMPANIES);

    log(`\n${'='.repeat(72)}`);
    log(COMMIT ? '  MIGRATION — COMMIT MODE (writes will be applied)' : '  MIGRATION — DRY RUN (no writes)');
    log('='.repeat(72));

    // ── 1. Group clients by company name ─────────────────────────────────
    const clients = (await users
        .find({ role: ROLES.CLIENT })
        .sort({ created_at: 1 })
        .toArray()) as unknown as ClientUser[];

    log(`\n[1] ${clients.length} client user(s) found.`);

    const groups = new Map<string, { display: string; members: ClientUser[] }>();
    const noName: ClientUser[] = [];
    const alreadyDone: ClientUser[] = [];
    for (const c of clients) {
        // Already migrated (a prior run set company_id and cleared the
        // name). Skip rather than reporting them as un-migratable — this
        // script isn't idempotent, but a re-run shouldn't cry wolf.
        if (c.client_profile?.company_id) {
            alreadyDone.push(c);
            continue;
        }
        const raw = c.client_profile?.company_name?.trim();
        if (!raw) {
            noName.push(c);
            continue;
        }
        const key = groupKey(raw);
        const g = groups.get(key);
        if (g) g.members.push(c);
        else groups.set(key, { display: raw, members: [c] });
    }

    if (alreadyDone.length > 0) {
        log(`\n  i  ${alreadyDone.length} client(s) already have a company_id — skipping (already migrated).`);
    }

    if (noName.length > 0) {
        log(`\n  !! ${noName.length} client(s) have NO company_name and cannot be migrated:`);
        for (const c of noName) log(`     - ${c.full_name} <${c.email}>`);
        log('     They will be left as-is with no company_id (they will see NO projects');
        log('     until an admin assigns them a company). Fix these first if unexpected.');
    }

    log(`\n[2] ${groups.size} distinct company(ies):`);
    for (const [, g] of groups) {
        log(`     • ${g.display}  (${g.members.length} client(s))`);
        for (const m of g.members) log(`         - ${m.full_name} <${m.email}>`);
    }

    // ── Merge warnings — case/whitespace variants collapsing together ────
    const merges = [...groups.values()].filter(
        (g) => new Set(g.members.map((m) => m.client_profile?.company_name?.trim())).size > 1
    );
    if (merges.length > 0) {
        log(`\n  !! ${merges.length} MERGE(S) — these spellings collapse into ONE company.`);
        log('     Correct if they are the same company; WRONG if they are not.');
        for (const g of merges) {
            const variants = [...new Set(g.members.map((m) => m.client_profile?.company_name))];
            log(`     • "${g.display}"  ← ${variants.map((v) => JSON.stringify(v)).join(', ')}`);
        }
    }

    // ── 3. Resolve company per project ───────────────────────────────────
    //
    // EVERY project with a legacy `client_ids` field — including ones whose
    // array is EMPTY. Skipping the empties looks harmless but isn't: they'd
    // keep a stale `client_ids` and never gain `representative_ids`, and
    // `.lean()` reads don't apply Mongoose defaults, so
    // `project.representative_ids.some(...)` would throw on a missing field
    // (a 500, not a silent wrong answer). An internal project with no client
    // side still needs `company_id: null` + `representative_ids: []` written.
    const legacyProjects = (await projects
        .find({ client_ids: { $exists: true } })
        .toArray()) as unknown as LegacyProject[];

    // client _id → group key
    const companyOfClient = new Map<string, string>();
    for (const [key, g] of groups) for (const m of g.members) companyOfClient.set(String(m._id), key);

    interface Plan {
        project: LegacyProject;
        chosen: string | null;
        dropped: ClientUser[];
        kept: mongoose.Types.ObjectId[];
    }
    const plans: Plan[] = [];

    for (const p of legacyProjects) {
        const ids = p.client_ids ?? [];
        const byCompany = new Map<string, ClientUser[]>();
        const orphans: mongoose.Types.ObjectId[] = [];
        for (const id of ids) {
            const key = companyOfClient.get(String(id));
            if (!key) {
                orphans.push(id);
                continue;
            }
            const list = byCompany.get(key) ?? [];
            list.push(clients.find((c) => String(c._id) === String(id))!);
            byCompany.set(key, list);
        }

        if (byCompany.size === 0) {
            plans.push({ project: p, chosen: null, dropped: [], kept: [] });
            continue;
        }

        // Pick rule: most reps wins; tie → the company whose earliest client
        // was created first (clients are sorted by created_at above, so the
        // first-seen group key is the earliest).
        let chosen = '';
        let best = -1;
        for (const [key, members] of byCompany) {
            if (members.length > best) {
                best = members.length;
                chosen = key;
            }
        }

        const dropped = [...byCompany.entries()].filter(([key]) => key !== chosen).flatMap(([, members]) => members);

        plans.push({
            project: p,
            chosen,
            dropped,
            kept: (byCompany.get(chosen) ?? []).map((m) => m._id),
        });

        if (orphans.length > 0) {
            log(`\n  !! Project "${p.name}" references ${orphans.length} client id(s) with no company.`);
        }
    }

    log(`\n[3] ${legacyProjects.length} project(s) with a client roster:`);
    for (const plan of plans) {
        const label = plan.chosen ? groups.get(plan.chosen)!.display : '(none — no resolvable company)';
        log(`     • ${plan.project.code} "${plan.project.name}" → ${label}`);
    }

    const conflicted = plans.filter((p) => p.dropped.length > 0);
    if (conflicted.length > 0) {
        log(`\n  !! ${conflicted.length} MULTI-COMPANY PROJECT(S) — cannot migrate cleanly.`);
        log('     One company per project is the model, so the others are dropped.');
        log('     THESE PEOPLE LOSE ACCESS TO THAT PROJECT:');
        for (const p of conflicted) {
            log(`     • ${p.project.code} "${p.project.name}" → kept ${groups.get(p.chosen!)!.display}`);
            for (const d of p.dropped) {
                const co = groups.get(companyOfClient.get(String(d._id))!)!.display;
                log(`         - DROPPED ${d.full_name} <${d.email}>  (${co})`);
            }
        }
    }

    if (!COMMIT) {
        log(`\n${'='.repeat(72)}`);
        log('  DRY RUN — nothing written. Re-run with --commit to apply.');
        log('='.repeat(72));
        await disconnectDB();
        return;
    }

    // ── COMMIT ───────────────────────────────────────────────────────────
    log(`\n${'='.repeat(72)}`);
    log('  APPLYING');
    log('='.repeat(72));

    const now = new Date();
    const firstAdmin = await users.findOne({ role: ROLES.ADMIN });
    const createdBy = firstAdmin?._id ?? clients[0]?._id;

    // 1) Companies
    const companyIdByKey = new Map<string, mongoose.Types.ObjectId>();
    for (const [key, g] of groups) {
        const existing = await companies.findOne({ name: g.display });
        if (existing) {
            companyIdByKey.set(key, existing._id);
            log(`  = company exists: ${g.display}`);
            continue;
        }
        const res = await companies.insertOne({
            name: g.display,
            status: 'active',
            created_by: createdBy,
            created_at: now,
            updated_at: now,
        });
        companyIdByKey.set(key, res.insertedId);
        log(`  + company: ${g.display}`);
    }

    // 2) Clients → company_id. Role deliberately untouched.
    for (const [key, g] of groups) {
        const companyId = companyIdByKey.get(key)!;
        for (const m of g.members) {
            await users.updateOne(
                { _id: m._id },
                {
                    $set: { 'client_profile.company_id': companyId },
                    $unset: { 'client_profile.company_name': '', 'client_profile.point_of_contact': '' },
                }
            );
        }
        log(`  ~ ${g.members.length} client(s) → ${g.display}`);
    }

    // 3) Projects → company_id + representative_ids
    for (const plan of plans) {
        const companyId = plan.chosen ? companyIdByKey.get(plan.chosen)! : null;
        await projects.updateOne(
            { _id: plan.project._id },
            {
                $set: { company_id: companyId, representative_ids: plan.kept },
                $unset: { client_ids: '' },
            }
        );
        log(`  ~ project ${plan.project.code} → ${plan.chosen ? groups.get(plan.chosen)!.display : 'no company'}`);
    }

    // 4) Roster reconcile — every company's `client`s onto that company's
    //    projects. Access-wise redundant (clients are company-scoped); this
    //    just keeps the roster field complete.
    for (const [key, g] of groups) {
        const companyId = companyIdByKey.get(key)!;
        const ids = g.members.map((m) => m._id);
        const res = await projects.updateMany(
            { company_id: companyId },
            { $addToSet: { representative_ids: { $each: ids } } }
        );
        if (res.modifiedCount > 0) log(`  ~ rostered ${ids.length} client(s) onto ${res.modifiedCount} project(s)`);
    }

    log('\n  Done.');
    log('  NOTE: historic audit_logs keep the old {client_ids:[...]} snapshot');
    log('  shape. They are immutable and are NOT rewritten — audit readers');
    log('  must tolerate both shapes.');
    await disconnectDB();
};

run().catch(async (err) => {
    console.error(err);
    await disconnectDB().catch(() => {});
    process.exit(1);
});
