/**
 * Halo API resource names in one place.
 *
 * Halo's endpoint naming is inconsistent (singular here, plural there) and has
 * shifted between versions. Every handler references these constants rather
 * than string literals, so if a tenant's Halo build names an endpoint
 * differently, it is a one-line correction here instead of a hunt through the
 * mappers.
 */
export const HALO = {
  client: 'Client',
  site: 'Site',
  user: 'Users',
  agent: 'Agent',
  ticket: 'Tickets',
  action: 'Actions',
  milestone: 'Milestone',
  template: 'Template',
  opportunity: 'Opportunities',
  contract: 'ClientContract',
  item: 'Item',
  supplier: 'Supplier',
  kbArticle: 'KBArticle',
  attachment: 'Attachment',
  status: 'Status',
  priority: 'Priority',
  ticketType: 'TicketType',
  team: 'Team',
  category: 'Category',
} as const

export type HaloResource = (typeof HALO)[keyof typeof HALO]
