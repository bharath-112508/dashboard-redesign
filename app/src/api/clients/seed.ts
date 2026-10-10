import type { ClientTeamMember } from '../types'

/**
 * Members the Daco team added on the Clients portal. Neither is a company
 * contact (Companies seed lists Ingrid Solberg and Lars Moen), so both stay here.
 */
export const CLIENT_TEAM_SEED: ClientTeamMember[] = [
  { id: 'ct1', companyId: 'daco', name: 'Anna Lindqvist', email: 'anna@daco.se' },
  { id: 'ct2', companyId: 'daco', name: 'Erik Nyström', email: 'erik@daco.se' },
]
