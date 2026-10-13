#!/usr/bin/env node
/**
 * Dev-only: send a real push notification to every stored subscription
 * for a user. Bypasses the dispatcher so we exercise just the
 * VAPID + web-push + browser SW path.
 *
 * Usage:
 *   node scripts/dev-test-push.mjs <email> [title] [body] [link_url]
 *
 * Refuses to run in production.
 */

import 'dotenv/config';
import { MongoClient } from 'mongodb';
import webPush from 'web-push';

const [, , email, titleArg, bodyArg, linkArg] = process.argv;
if (!email) {
    console.error('Usage: node scripts/dev-test-push.mjs <email> [title] [body] [link_url]');
    process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run in production.');
    process.exit(2);
}
const { MONGO_URI, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
if (!MONGO_URI) { console.error('MONGO_URI not set.'); process.exit(3); }
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY || !VAPID_SUBJECT) {
    console.error('VAPID_* env vars not set.'); process.exit(4);
}

webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

const payload = {
    title: titleArg || 'Test push',
    body: bodyArg || 'This is a dev-test push notification from dev-test-push.mjs',
    link_url: linkArg || '/me',
    type: 'dev_test',
    related_id: 'dev-test-' + Date.now(),
    // Stay on screen until clicked — without this macOS auto-dismisses
    // the banner after ~5 seconds.
    require_interaction: true,
};

const client = new MongoClient(MONGO_URI);
try {
    await client.connect();
    const dbName = new URL(MONGO_URI.replace('mongodb+srv://', 'https://').replace('mongodb://', 'https://')).pathname.slice(1).split('?')[0];
    const db = client.db(dbName);
    const user = await db.collection('users').findOne({ email });
    if (!user) { console.error(`No user with email ${email}`); process.exit(5); }
    const subs = await db.collection('push_subscriptions').find({ user_id: user._id }).toArray();
    if (subs.length === 0) {
        console.error(`No push subscriptions for ${email} (toggle "Browser notifications" on first).`);
        process.exit(6);
    }
    console.log(`Found ${subs.length} subscription(s) for ${email}. Sending payload:`);
    console.log(JSON.stringify(payload, null, 2));
    for (const sub of subs) {
        try {
            const res = await webPush.sendNotification(
                { endpoint: sub.endpoint, keys: sub.keys },
                JSON.stringify(payload)
            );
            console.log(`  OK  endpoint=${sub.endpoint.slice(0, 60)}…  status=${res.statusCode}`);
        } catch (err) {
            console.error(`  FAIL endpoint=${sub.endpoint.slice(0, 60)}…  status=${err.statusCode}  body=${err.body}`);
        }
    }
} finally {
    await client.close();
}
