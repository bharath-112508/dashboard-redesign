import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import isoWeek from 'dayjs/plugin/isoWeek.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.extend(isoWeek);

/** Plan-wide default timezone for business dates / working-day math. */
export const DEFAULT_TIMEZONE = 'Asia/Kolkata';

dayjs.tz.setDefault(DEFAULT_TIMEZONE);

/** Standard date-only format used in APIs (plan §Dates & Timezones). */
export const DATE_FORMAT = 'YYYY-MM-DD';

export default dayjs;
