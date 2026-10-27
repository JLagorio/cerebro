import { describe, expect, it } from 'vitest';
import { creationDraftKey, type CreationContext } from './creationDestination';

const page: CreationContext = {
  vault: '/vault',
  pane: 'p1',
  destination: { kind: 'page', folder: '', recipe: { kind: 'blank' } },
};

describe('creation identity', () => {
  it('excludes pane but includes vault, folder and immutable recipe', () => {
    expect(creationDraftKey({ ...page, pane: 'p2' })).toBe(creationDraftKey(page));
    expect(creationDraftKey({ ...page, vault: '/other' })).not.toBe(creationDraftKey(page));
    expect(
      creationDraftKey({
        ...page,
        destination: { kind: 'page', folder: 'notes', recipe: { kind: 'blank' } },
      }),
    ).not.toBe(creationDraftKey(page));
    expect(
      creationDraftKey({
        ...page,
        destination: { kind: 'page', folder: '', recipe: { kind: 'sheet', sheetName: 'Sheet1' } },
      }),
    ).not.toBe(creationDraftKey(page));
  });

  it('distinguishes record database, host and group without property-order dependence', () => {
    const record: CreationContext = {
      ...page,
      destination: { kind: 'record', typeName: 'Task', host: null, group: null },
    };
    const grouped: CreationContext = {
      ...record,
      destination: {
        kind: 'record',
        typeName: 'Task',
        host: { path: 'projects/a.md', field: 'project' },
        group: { field: 'status', value: 'open' },
      },
    };
    expect(creationDraftKey(record)).not.toBe(creationDraftKey(grouped));
    expect(creationDraftKey(grouped)).toBe(
      creationDraftKey({
        ...grouped,
        destination: {
          group: { value: 'open', field: 'status' },
          host: { field: 'project', path: 'projects/a.md' },
          typeName: 'Task',
          kind: 'record',
        },
      }),
    );
    expect(
      creationDraftKey({
        ...record,
        destination: { ...record.destination, typeName: 'Project' },
      } as CreationContext),
    ).not.toBe(creationDraftKey(record));
  });
});
