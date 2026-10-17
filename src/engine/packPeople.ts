import type { Pack } from './packs';
const interaction = {
  kind: 'rollup',
  source: 'correspondence',
  property: 'last_message_at',
  calculate: 'latest',
};
const latest = [{ field: 'last_interaction', dir: 'desc' }];
/** Optional databases, never reserved names or routing rules. */
export const PEOPLE_PACK: Pack = {
  name: 'People and companies',
  types: [
    {
      path: 'types/company.md',
      name: 'Company',
      properties: {
        folder: 'companies',
        email_domain: 'domain',
        fields: {
          domain: { kind: 'text' },
          stage: {
            kind: 'select',
            options: ['lead', 'talking', 'proposal', 'customer', 'lost'].map((id) => ({
              id,
              label: id.charAt(0).toUpperCase() + id.slice(1),
            })),
          },
          website: { kind: 'url' },
          people: { kind: 'relation', from: { type: 'Person', field: 'company' } },
          last_interaction: interaction,
        },
        views: [
          {
            id: 'pipeline',
            name: 'Pipeline',
            presentation: { type: 'board', group: [{ field: 'stage' }], sort: latest },
          },
          { id: 'all', name: 'All', presentation: { type: 'table', group: [], sort: latest } },
        ],
      },
      body: 'Companies you work with. Set a domain to see the cached mail you exchanged with its people.',
    },
    {
      path: 'types/person.md',
      name: 'Person',
      properties: {
        folder: 'people',
        fields: {
          email: { kind: 'email' },
          company: { kind: 'relation', target: 'Company', limit: 1 },
          role: { kind: 'text' },
          phone: { kind: 'phone' },
          last_interaction: interaction,
        },
        views: [
          { id: 'all', name: 'All', presentation: { type: 'table', group: [], sort: latest } },
        ],
      },
      body: 'People you know. An email address connects this page to its cached threads. Shared addresses stay unmatched.',
    },
  ],
};
