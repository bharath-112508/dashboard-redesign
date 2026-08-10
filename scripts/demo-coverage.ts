/** READ-ONLY. Per-day coverage for the last N days, so gaps are visible. */
import 'dotenv/config';
import mongoose from 'mongoose';

const DAYS = 16;

const main = async (): Promise<void> => {
    await mongoose.connect(process.env.MONGO_URI!);
    const db = mongoose.connection.db!;

    const staff = await db
        .collection('users')
        .find({ role: { $nin: ['client', 'representative'] }, status: 'active' })
        .toArray();
    const holidays = new Set((await db.collection('holidays').distinct('date')).map(String));
    const today = new Date().toISOString().slice(0, 10);

    console.log(`staff: ${staff.length}   today: ${today}\n`);
    console.log('date        dow  kind      attend(present)  timesheets(people)  tasks_touched  comments  leaves');
    console.log('-'.repeat(104));

    for (let i = DAYS - 1; i >= 0; i--) {
        const d = new Date(`${today}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() - i);
        const iso = d.toISOString().slice(0, 10);
        const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
        const weekend = d.getUTCDay() === 0 || d.getUTCDay() === 6;
        const kind = weekend ? 'weekend' : holidays.has(iso) ? 'holiday' : 'work';

        const present = await db
            .collection('attendance_records')
            .countDocuments({ local_date: iso, status: 'present' });
        const tsPeople = (await db.collection('timesheet_entries').distinct('user_id', { local_date: iso })).length;
        const tsRows = await db.collection('timesheet_entries').countDocuments({ local_date: iso });

        const from = new Date(`${iso}T00:00:00Z`);
        const to = new Date(`${iso}T23:59:59Z`);
        const acts = await db.collection('task_activities').countDocuments({ created_at: { $gte: from, $lte: to } });
        const cmts = await db.collection('task_comments').countDocuments({ created_at: { $gte: from, $lte: to } });
        const leaves = await db
            .collection('leave_requests')
            .countDocuments({ start_date: { $lte: iso }, end_date: { $gte: iso }, status: 'approved' });

        const flag = kind === 'work' && (tsPeople < 5 || acts === 0) ? '   <-- thin' : '';
        console.log(
            `${iso}  ${dow}  ${kind.padEnd(8)}  ${String(present).padStart(9)}       ${String(tsPeople).padStart(4)} (${String(tsRows).padStart(2)} rows)      ${String(acts).padStart(6)}       ${String(cmts).padStart(4)}     ${String(leaves).padStart(3)}${flag}`
        );
    }

    await mongoose.disconnect();
};

void main().catch((e) => {
    console.error(e);
    process.exit(1);
});
