import type { Entry } from '@/engine/types';

export function makeEntry(partial: Partial<Entry> & { path: string }): Entry {
  const filename = partial.path.split('/').pop() ?? partial.path;
  return {
    filename,
    folder: partial.path.includes('/') ? partial.path.slice(0, partial.path.lastIndexOf('/')) : '',
    project: null,
    title: filename.replace(/\.md$/, ''),
    type: null,
    properties: {},
    relationships: {},
    outgoingLinks: [],
    snippet: '',
    createdAt: '2026-07-01T09:00:00Z',
    modifiedAt: '2026-07-02T09:00:00Z',
    parseError: null,
    ...partial,
  };
}

/** Minimal v2 vault: type notes (statuses on the Work item type doc), one
 * project folder (FLD) with contained items, one person, one broken item. */
export function fixtureVault(): Entry[] {
  const PROJECT = 'projects/onboarding/project.md';
  return [
    makeEntry({
      path: 'types/work-item.md',
      title: 'Work item',
      type: 'Type',
      properties: {
        icon: 'circle-check',
        color: 'var(--cortex-500)',
        statuses: [
          { id: 'todo', group: 'active', color: 'var(--n-500)', hollow: true },
          { id: 'doing', group: 'active', color: 'var(--warn-500)' },
          { id: 'done', group: 'done', color: 'var(--success-500)' },
        ],
        fields: {
          status: { kind: 'status' },
          priority: {
            kind: 'select',
            options: [
              { id: 'high', color: '#DE8F0A' },
              { id: 'low', color: '#A8AFC2' },
            ],
          },
          assignee: { kind: 'person' },
          due: { kind: 'date' },
        },
      } as unknown as Entry['properties'],
    }),
    makeEntry({
      path: 'types/project.md',
      title: 'Project',
      type: 'Type',
      properties: { icon: 'folder', color: 'var(--n-600)' },
    }),
    makeEntry({
      path: 'types/person.md',
      title: 'Person',
      type: 'Type',
      properties: { icon: 'user', color: 'var(--n-600)' },
    }),
    makeEntry({
      path: PROJECT,
      project: PROJECT,
      title: 'Guided onboarding',
      type: 'Project',
      properties: { key: 'FLD' },
    }),
    makeEntry({ path: 'people/ana-rios.md', title: 'Ana Rios', type: 'Person' }),
    makeEntry({
      path: 'projects/onboarding/items/fld-1.md',
      project: PROJECT,
      title: 'Design first-run flow',
      type: 'Work item',
      properties: { key: 'FLD-1', status: 'todo', priority: 'high', channel: 'field-ops' },
      relationships: { assignee: ['ana-rios'] },
    }),
    makeEntry({
      path: 'projects/onboarding/items/fld-2.md',
      project: PROJECT,
      title: 'Wire field sync banner',
      type: 'Work item',
      properties: { key: 'FLD-2', status: 'doing', priority: 'low' },
    }),
    makeEntry({
      path: 'projects/onboarding/items/broken.md',
      project: PROJECT,
      title: 'broken',
      type: null,
      parseError: 'bad yaml: line 2',
    }),
  ];
}
