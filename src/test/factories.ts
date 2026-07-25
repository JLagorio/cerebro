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

/** Minimal Meridian-style vault: type notes, one space (todo/doing/done), one project (FLD), one person, three items. */
export function fixtureVault(): Entry[] {
  return [
    makeEntry({
      path: 'type/work-item.md',
      title: 'Work item',
      type: 'Type',
      properties: {
        icon: 'circle-check',
        color: 'var(--cortex-500)',
        fields: {
          status: { kind: 'status' },
          priority: {
            kind: 'select',
            options: [{ id: 'high', color: '#DE8F0A' }, { id: 'low', color: '#A8AFC2' }],
          },
          assignee: { kind: 'person' },
          due: { kind: 'date' },
          project: { kind: 'relation', target: 'Project' },
        },
      } as unknown as Entry['properties'],
    }),
    makeEntry({ path: 'type/project.md', title: 'Project', type: 'Type', properties: { icon: 'folder', color: 'var(--n-600)' } }),
    makeEntry({ path: 'type/space.md', title: 'Space', type: 'Type', properties: { icon: 'box', color: 'var(--n-600)' } }),
    makeEntry({ path: 'type/person.md', title: 'Person', type: 'Type', properties: { icon: 'user', color: 'var(--n-600)' } }),
    makeEntry({
      path: 'spaces/field-platform.md',
      title: 'Field platform',
      type: 'Space',
      properties: {
        color: 'var(--swatch-teal)',
        statuses: [
          { id: 'todo', group: 'active', color: 'var(--n-500)', hollow: true },
          { id: 'doing', group: 'active', color: 'var(--warn-500)' },
          { id: 'done', group: 'done', color: 'var(--success-500)' },
        ],
      } as unknown as Entry['properties'],
    }),
    makeEntry({
      path: 'projects/onboarding.md',
      title: 'Guided onboarding',
      type: 'Project',
      properties: { key: 'FLD' },
      relationships: { space: ['field-platform'] },
    }),
    makeEntry({ path: 'people/ana-rios.md', title: 'Ana Rios', type: 'Person' }),
    makeEntry({
      path: 'items/fld-1.md',
      title: 'Design first-run flow',
      type: 'Work item',
      properties: { key: 'FLD-1', status: 'todo', priority: 'high', channel: 'field-ops' },
      relationships: { project: ['onboarding'], assignee: ['ana-rios'] },
    }),
    makeEntry({
      path: 'items/fld-2.md',
      title: 'Wire field sync banner',
      type: 'Work item',
      properties: { key: 'FLD-2', status: 'doing', priority: 'low' },
      relationships: { project: ['onboarding'] },
    }),
    makeEntry({ path: 'items/broken.md', title: 'broken', type: null, parseError: 'bad yaml: line 2' }),
  ];
}
