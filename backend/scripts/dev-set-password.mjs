#!/usr/bin/env node
/**
 * Dev-only: set a user's password directly via Mongo, bypassing the
 * email-link reset flow. Useful when the email transport is misconfigured
 * or when you need a known password for an integration test account.
 *
 * Usage:
 *   node scripts/dev-set-password.mjs <email> <new-password>
 *
 * Reads MONGO_URI from process.env (load with `dotenv` if you keep
 * secrets in a .env file).
 *
 * Safety: refuses to run if NODE_ENV === 'production'.
 */

import 'dotenv/config';
import bcrypt from 'bcrypt';
import { MongoClient } from 'mongodb';

const ROUNDS = 12; // mirror BCRYPT_ROUNDS in src/constants/auth.ts

const [, , email, newPassword] = process.argv;
if (!email || !newPassword) {
    console.error('Usage: node scripts/dev-set-password.mjs <email> <new-password>');
    process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
    console.error('Refusing to run in production. Use the admin reset flow.');
    process.exit(2);
}

const uri = process.env.MONGO_URI;
if (!uri) {
    console.error('MONGO_URI not set in env.');
    process.exit(3);
}

const client = new MongoClient(uri);
try {
    await client.connect();
    const dbName = new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'https://')).pathname.slice(1).split('?')[0];
    const db = client.db(dbName);
    const users = db.collection('users');

    const user = await users.findOne({ email });
    if (!user) {
        console.error(`No user with email ${email}`);
        process.exit(4);
    }

    const hash = await bcrypt.hash(newPassword, ROUNDS);
    const result = await users.updateOne(
        { _id: user._id },
        { $set: { password_hash: hash, updated_at: new Date() } }
    );
    console.log(`Updated ${email} (modifiedCount=${result.modifiedCount}, userId=${user._id})`);
} finally {
    await client.close();
}
