#!/usr/bin/env node
/** Dev-only: list push subscriptions per user — used to debug why a recipient didn't get a push. */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

const [, , email] = process.argv;
const { MONGO_URI } = process.env;
if (!MONGO_URI) { console.error('MONGO_URI not set.'); process.exit(1); }

const client = new MongoClient(MONGO_URI);
try {
    await client.connect();
    const dbName = new URL(MONGO_URI.replace('mongodb+srv://', 'https://').replace('mongodb://', 'https://')).pathname.slice(1).split('?')[0];
    const db = client.db(dbName);

    const filter = email ? { email } : { role: { $in: ['admin', 'manager'] } };
    const users = await db.collection('users').find(filter).project({ _id: 1, email: 1, role: 1, status: 1, push_notifications_enabled: 1 }).toArray();
    for (const u of users) {
        const subs = await db.collection('push_subscriptions').find({ user_id: u._id }).toArray();
        console.log(`${u.email}  role=${u.role}  status=${u.status}  push_enabled=${u.push_notifications_enabled !== false}  subscriptions=${subs.length}`);
        for (const s of subs) {
            console.log(`    endpoint=${s.endpoint.slice(0, 70)}…  ua=${(s.user_agent || '').slice(0, 40)}  last_used=${s.last_used_at?.toISOString() ?? '—'}  last_error=${s.last_error_at?.toISOString() ?? '—'}`);
        }
    }
} finally {
    await client.close();
}
