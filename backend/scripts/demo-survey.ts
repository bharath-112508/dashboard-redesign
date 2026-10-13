/**
 * READ-ONLY survey of the demo dataset, written to plan the pre-demo cleanup.
 *
 * Touches nothing. Prints what exists, per company, so the destructive script
 * that follows can be scoped from real counts instead of guesses.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const main = async (): Promise<void> => {
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI missing');
    const dbName = new URL(uri.replace('mongodb+srv://', 'https://')).pathname.slice(1);
    console.log(`DB: ${dbName}\n`);

    await mongoose.connect(uri);
    const db = mongoose.connection.db!;

    const names = (await db.listCollections().toArray()).map((c) => c.name).sort();
    console.log('collections:', names.join(', '), '\n');

    const companies = await db.collection('companies').find({}).toArray();
    const projects = await db.collection('projects').find({}).toArray();

    console.log('=== COMPANIES ===');
    for (const c of companies) {
        const own = projects.filter((p) => String(p.company_id) === String(c._id));
        const people = await db.collection('users').countDocuments({ 'client_profile.company_id': c._id });
        console.log(
            `${String(c._id)}  ${JSON.stringify(c.name)}  status=${c.status ?? '-'}  projects=${own.length}  people=${people}`
        );
        for (const p of own) console.log(`      - ${p.code ?? '?'}  ${p.name}  (${String(p._id)})`);
    }

    const orphans = projects.filter((p) => !p.company_id);
    if (orphans.length) {
        console.log(`\n(no company_id) projects=${orphans.length}`);
        for (const p of orphans) console.log(`      - ${p.code ?? '?'}  ${p.name}  (${String(p._id)})`);
    }

    console.log('\n=== ROW COUNTS ===');
    for (const n of names) {
        console.log(`${String(await db.collection(n).countDocuments()).padStart(6)}  ${n}`);
    }

    console.log('\n=== USERS BY ROLE ===');
    for (const r of await db
        .collection('users')
        .aggregate([{ $group: { _id: { role: '$role', status: '$status' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }])
        .toArray()) {
        console.log(`${String(r.n).padStart(4)}  ${r._id.role} / ${r._id.status}`);
    }

    await mongoose.disconnect();
};

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
