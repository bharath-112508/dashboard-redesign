/**
 * READ-ONLY demo DB status report. Prints what data exists so we can spot gaps
 * before a demo. Run: npx tsx scripts/dev-demo-status.ts
 */
import connectDB, { disconnectDB } from '../src/config/database.config.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../src/utils/date.js';
import { User } from '../src/models/user.model.js';
import { AttendanceRecord } from '../src/models/attendance-record.model.js';
import { Project } from '../src/models/project.model.js';
import { Task } from '../src/models/task.model.js';
import { Sprint } from '../src/models/sprint.model.js';
import { Story } from '../src/models/story.model.js';
import { TimesheetEntry } from '../src/models/timesheet-entry.model.js';
import { LeaveRequest } from '../src/models/leave-request.model.js';
import { LeaveBalance } from '../src/models/leave-balance.model.js';
import { Holiday } from '../src/models/holiday.model.js';
import { OfficeLocation } from '../src/models/office-location.model.js';
import { getOrInitSettings } from '../src/services/settings.service.js';

const minuteOfDay = (d: Date): number => {
    const ist = dayjs(d).tz(DEFAULT_TIMEZONE);
    return ist.hour() * 60 + ist.minute();
};
const hhmm = (d: Date): string => dayjs(d).tz(DEFAULT_TIMEZONE).format('HH:mm');

async function main() {
    await connectDB();
    const today = dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
    console.log(`\n=== DEMO DB STATUS · today (IST) = ${today} ===\n`);

    const settings = await getOrInitSettings();
    const startTime = settings.work_schedule?.start_time ?? '(unset)';
    const expHours = settings.work_schedule?.daily_expected_hours ?? '(unset)';
    const startHour = Number(String(startTime).split(':')[0]) + Number(String(startTime).split(':')[1] ?? 0) / 60;
    const lateAfter = Number.isFinite(startHour) ? Math.round(startHour * 60) + 10 : null;
    console.log(`Work schedule: start ${startTime}, expected ${expHours}h/day · late after ~${
        lateAfter !== null ? `${Math.floor(lateAfter / 60)}:${String(lateAfter % 60).padStart(2, '0')}` : 'n/a'
    }\n`);

    // Users by role + status
    const users = await User.find({}).select('full_name email role status').lean();
    const byRole: Record<string, { active: number; deactivated: number }> = {};
    for (const u of users as any[]) {
        byRole[u.role] ??= { active: 0, deactivated: 0 };
        if (u.status === 'active') byRole[u.role].active++;
        else byRole[u.role].deactivated++;
    }
    console.log('Users by role:');
    for (const [role, c] of Object.entries(byRole)) console.log(`  ${role.padEnd(11)} active ${c.active}  deactivated ${c.deactivated}`);

    // Content counts
    const [projects, tasks, sprints, stories, tsTotal, tsToday, leaves, balances, holidays, offices] = await Promise.all([
        Project.countDocuments({}),
        Task.countDocuments({}),
        Sprint.countDocuments({}),
        Story.countDocuments({}),
        TimesheetEntry.countDocuments({}),
        TimesheetEntry.countDocuments({ local_date: today }),
        LeaveRequest.countDocuments({}),
        LeaveBalance.countDocuments({}),
        Holiday.countDocuments({}),
        OfficeLocation.countDocuments({}),
    ]);
    console.log('\nContent:');
    console.log(`  projects ${projects} · sprints ${sprints} · stories ${stories} · tasks ${tasks}`);
    console.log(`  timesheet entries: ${tsTotal} total, ${tsToday} for today`);
    console.log(`  leave requests ${leaves} · leave balances ${balances} · holidays ${holidays} · office locations ${offices}`);

    // Today's attendance for internal staff (non-client)
    const internal = (users as any[]).filter((u) => u.role !== 'client' && u.status === 'active');
    const recs = await AttendanceRecord.find({ local_date: today }).lean();
    const recByUser = new Map(recs.map((r: any) => [String(r.user_id), r]));
    let present = 0, late = 0, checkedOut = 0, notIn = 0, incomplete = 0;
    console.log(`\nToday's attendance (${internal.length} active internal users):`);
    for (const u of internal) {
        const r: any = recByUser.get(String(u._id));
        if (!r || !r.check_in) { notIn++; continue; }
        const inMin = minuteOfDay(new Date(r.check_in.time));
        const isLate = lateAfter !== null && inMin > lateAfter;
        const out = r.check_out ? ` → out ${hhmm(new Date(r.check_out.time))}` : ' (in progress)';
        if (r.status === 'incomplete') incomplete++;
        if (r.check_out) checkedOut++;
        if (isLate) late++; else present++;
        // Uncomment for per-user detail:
        // console.log(`  ${u.full_name.padEnd(20)} in ${hhmm(new Date(r.check_in.time))}${out} ${isLate ? 'LATE' : ''} [${r.status}]`);
    }
    console.log(`  checked-in: ${present + late}  (on-time ${present}, late ${late})`);
    console.log(`  checked-out: ${checkedOut}  · incomplete: ${incomplete}`);
    console.log(`  NOT checked in: ${notIn}`);

    await disconnectDB();
    console.log('\n=== done ===\n');
}

main().catch(async (e) => {
    console.error(e);
    await disconnectDB().catch(() => {});
    process.exit(1);
});
