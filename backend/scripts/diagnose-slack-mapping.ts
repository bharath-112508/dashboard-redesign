/**
 * READ-ONLY diagnostic for the Slack user-mapping bug.
 *
 * Symptom: a team lead opening the Slack App Home sees the Admin's data.
 * Hypothesis: the wrong User row holds the team lead's slack_user_id.
 *
 * Prints who currently holds the reported Slack ID, plus the candidate
 * users (admin + rajashekar) and their slack_user_id mapping. No writes.
 *
 * Run: npx tsx scripts/diagnose-slack-mapping.ts U0510FZDQF4
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { User } from '../src/models/user.model.js';

const slackId = process.argv[2] ?? 'U0510FZDQF4';

const fmt = (u: {
    _id: unknown;
    full_name?: string | null;
    email?: string | null;
    role?: string | null;
    slack_user_id?: string | null;
} | null) =>
    u
        ? {
              _id: String(u._id),
              full_name: u.full_name ?? null,
              email: u.email ?? null,
              role: u.role ?? null,
              slack_user_id: u.slack_user_id ?? null,
          }
        : null;

const run = async () => {
    await connectDB();

    const holders = await User.find({ slack_user_id: slackId }).select(
        '_id full_name email role slack_user_id'
    );
    console.log(`\n=== Users whose slack_user_id == ${slackId} (${holders.length}) ===`);
    holders.forEach((u) => console.log(fmt(u)));

    const byName = await User.find({ full_name: /rajashekar/i }).select('_id full_name email role slack_user_id');
    console.log(`\n=== Users matching name /rajashekar/i (${byName.length}) ===`);
    byName.forEach((u) => console.log(fmt(u)));

    const admins = await User.find({ role: 'admin' }).select('_id full_name email role slack_user_id');
    console.log(`\n=== Admin users (${admins.length}) ===`);
    admins.forEach((u) => console.log(fmt(u)));

    // Any duplicate slack_user_id values across the collection (data integrity).
    const dups = await User.aggregate([
        { $match: { slack_user_id: { $ne: null } } },
        { $group: { _id: '$slack_user_id', count: { $sum: 1 }, users: { $push: '$full_name' } } },
        { $match: { count: { $gt: 1 } } },
    ]);
    console.log(`\n=== Duplicate slack_user_id values (${dups.length}) ===`);
    dups.forEach((d) => console.log(d));

    await disconnectDB();
};

run().catch(async (err) => {
    console.error('diagnostic failed:', err);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
});
