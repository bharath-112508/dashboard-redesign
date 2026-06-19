/**
 * One-off: clear specific Slack category channels so those categories stop
 * broadcasting to a channel (per-recipient DMs still go out). The dispatcher
 * skips a blank channel (`if (!channel)`).
 *
 * Defaults to clearing `leaves` + `attendance` (the request messages the admin
 * asked to remove from the channel).
 *
 * Run: npx tsx scripts/clear-slack-channels.ts leaves attendance
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import { SystemSettings } from '../src/models/system-settings.model.js';

const categories = process.argv.slice(2);
const toClear = categories.length > 0 ? categories : ['leaves', 'attendance'];

const run = async () => {
    await connectDB();

    const before = await SystemSettings.findOne().select('slack.channels').lean();
    console.log('\n=== BEFORE channels ===');
    console.log((before as { slack?: { channels?: unknown } } | null)?.slack?.channels ?? '(no settings doc)');

    const set: Record<string, string> = {};
    for (const c of toClear) set[`slack.channels.${c}`] = '';
    // updateOne does not run subdoc `required` validators — safe to write '' even
    // on a deployment whose model still marks channels required.
    const res = await SystemSettings.updateOne({}, { $set: set });
    console.log(`\nCleared [${toClear.join(', ')}] — matched ${res.matchedCount}, modified ${res.modifiedCount}.`);

    const after = await SystemSettings.findOne().select('slack.channels').lean();
    console.log('\n=== AFTER channels ===');
    console.log((after as { slack?: { channels?: unknown } } | null)?.slack?.channels);

    await disconnectDB();
};

run().catch(async (err) => {
    console.error('clear failed:', err);
    await disconnectDB().catch(() => undefined);
    process.exit(1);
});
