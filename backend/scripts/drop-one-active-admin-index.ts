/**
 * Drop the `one_active_admin` index so a deployment can have several admins.
 *
 *   npx tsx scripts/drop-one-active-admin-index.ts            # report only
 *   npx tsx scripts/drop-one-active-admin-index.ts --commit   # drop it
 *
 * WHY THIS EXISTS
 * ---------------
 * The platform used to enforce "exactly one active admin" with a partial
 * unique index on `{ role: 1 }` where `role = admin AND status = active`
 * (fix R6). That ceiling is gone from the schema, but Mongo keeps an index
 * that already exists — removing it from the model drops nothing. Until this
 * runs, promoting or creating a second admin still fails with E11000 on the
 * live data, while every test passes locally against a fresh database.
 *
 * Run it ONCE per environment (dev, prod, any demo DB) before, or together
 * with, the release that allows multiple admins.
 *
 * Safe to re-run: a missing index is reported, not an error. Dropping it
 * cannot lose data — an index is derived, and `assertNotLastAdmin` in
 * user.service.ts keeps the floor of one admin in application code.
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const INDEX_NAME = 'one_active_admin';

const main = async (): Promise<void> => {
    const commit = process.argv.includes('--commit');
    const uri = process.env.MONGO_URI;
    if (!uri) throw new Error('MONGO_URI is not set');

    await mongoose.connect(uri);
    const db = mongoose.connection.db!;
    console.log(`db: ${db.databaseName}`);

    const users = db.collection('users');
    const indexes = await users.indexes();
    const found = indexes.find((i) => i.name === INDEX_NAME);

    const admins = await users.countDocuments({ role: 'admin', status: 'active' });
    console.log(`active admins: ${admins}`);

    if (!found) {
        console.log(`index "${INDEX_NAME}" is not present — nothing to do.`);
    } else if (!commit) {
        console.log(`index "${INDEX_NAME}" IS present. Re-run with --commit to drop it.`);
    } else {
        await users.dropIndex(INDEX_NAME);
        console.log(`dropped "${INDEX_NAME}".`);
    }

    await mongoose.disconnect();
};

await main();
