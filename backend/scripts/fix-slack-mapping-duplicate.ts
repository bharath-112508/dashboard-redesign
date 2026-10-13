/**
 * One-off data fix for the duplicate Slack mapping bug.
 *
 * A Slack id must map to exactly one Viljetech user. This clears the given
 * `slack_user_id` from every account EXCEPT the confirmed correct owner
 * (matched by email), leaving that owner as the sole holder.
 *
 * Confirmed by scripts/diagnose-slack-mapping.ts: both admin@viljetech.com and
 * raj@viljetech.com held U0510FZDQF4; the correct owner is raj@viljetech.com.
 *
 * Run: npx tsx scripts/fix-slack-mapping-duplicate.ts U0510FZDQF4 raj@viljetech.com
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { User } from '../src/models/user.model.js';

const slackId = process.argv[2] ?? 'U0510FZDQF4';
const ownerEmail = (process.argv[3] ?? 'raj@viljetech.com').toLowerCase();

const run = async () => {
    await connectDB();

    const before = await User.find({ slack_user_id: slackId }).select('_id full_name email role slack_user_id');
    console.log(`\n=== BEFORE: holders of ${slackId} (${before.length}) ===`);
    before.forEach((u) => console.log({ id: String(u._id), name: u.full_name, email: u.email, role: u.role }));

    const owner = before.find((u) => (u.email ?? '').toLowerCase() === ownerEmail);
    if (!owner) {
        console.error(
            `\nABORT: no holder of ${slackId} has email ${ownerEmail}. ` +
                `Refusing to clear all mappings — re-check the correct owner.`
        );
        await disconnectDB();
        process.exit(1);
    }

    // Null the id on every OTHER holder; leave the confirmed owner untouched.
    const res = await User.updateMany(
        { slack_user_id: slackId, _id: { $ne: owner._id } },
        { $set: { slack_user_id: null } }
    );
    console.log(`\nCleared slack_user_id from ${res.modifiedCount} other account(s); kept it on ${ownerEmail}.`);

    const after = await User.find({ slack_user_id: slackId }).select('_id full_name email role slack_user_id');
    console.log(`\n=== AFTER: holders of ${slackId} (${after.length}) ===`);
    after.forEach((u) => console.log({ id: String(u._id), name: u.full_name, email: u.email, role: u.role }));

    await disconnectDB();
};

run().catch(async (err) => {
    console.error('fix failed:', err);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
});
