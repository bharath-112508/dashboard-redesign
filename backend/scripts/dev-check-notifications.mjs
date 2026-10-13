#!/usr/bin/env node
/** Dev-only: list the most recent in-app notifications for a user. */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const [, , email, limitArg] = process.argv;
const limit = Number(limitArg) || 5;
const { MONGO_URI } = process.env;
if (!email || !MONGO_URI) {
    console.error('Usage: MONGO_URI=… node scripts/dev-check-notifications.mjs <email> [limit]');
    process.exit(1);
}
const client = new MongoClient(MONGO_URI);
try {
    await client.connect();
    const dbName = new URL(MONGO_URI.replace('mongodb+srv://', 'https://').replace('mongodb://', 'https://')).pathname.slice(1).split('?')[0];
    const db = client.db(dbName);
    const u = await db.collection('users').findOne({ email });
    if (!u) { console.error('user not found'); process.exit(2); }
    const rows = await db.collection('notifications').find({ user_id: u._id }).sort({ created_at: -1 }).limit(limit).toArray();
    console.log(`Recent ${rows.length} notification(s) for ${email}:`);
    for (const r of rows) {
        console.log(`  ${r.created_at.toISOString()}  type=${r.type}  read=${r.read_at ? 'yes' : 'no'}  title="${r.title}"`);
    }
} finally {
    await client.close();
}
