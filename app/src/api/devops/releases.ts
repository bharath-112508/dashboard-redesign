import type { DvRelease } from './types'

/**
 * Production releases from the Tickets design (`DEPLOYS`), newest first, by
 * project key. 2.6.2 is the release the prototype brings in live, six seconds
 * after the page opens; here it is part of the data.
 */
export const SEED_RELEASES: Record<string, DvRelease[]> = {
  'OPS-106': [
    { v: '2.6.2', name: 'Bug fixes for ticket import', st: 'Live', at: '2026-10-10T11:40' },
    { v: '2.6.1', name: 'Ticket import and BankID login', st: 'Live', at: '2026-10-10T10:20' },
    { v: '2.6.0', name: 'Push notifications', st: 'Live', at: '2026-10-09T13:12' },
    { v: '2.5.3', name: 'Profile settings', st: 'Rolled back', at: '2026-10-08T16:40', note: 'Rolled back to 2.5.2' },
    { v: '2.5.2', name: 'Performance fixes', st: 'Live', at: '2026-10-06T10:05' },
    { v: '1.0.0', name: 'First go-live', st: 'Live', at: '2026-09-28T09:00' },
  ],
}
