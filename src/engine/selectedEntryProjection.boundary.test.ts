import { expect, it } from 'vitest';
import type { SelectedEntryProperties } from '@/lib/generated/workspace';
import { buildSchema } from './schema';
import { makeEntry } from './testHelpers';
const authority = {
  kind: 'sqlite_metadata' as const,
  workspaceId: 'workspace',
  recordId: 'record',
  metadataRevision: '1',
  metadataHash: 'a'.repeat(64),
  bodyHash: 'b'.repeat(64),
};
it.each([{}, { value: null }, null])(
  'a malformed outer canonical carrier %j refuses without throwing or falling back',
  (carrier) => {
    const entry = Object.assign(makeEntry({ authority, properties: { amount: 42 } }), {
      canonicalProperties: carrier as unknown as SelectedEntryProperties,
    });
    expect(() => buildSchema([entry]).resolveField(entry, 'amount')).not.toThrow();
    expect(buildSchema([entry]).resolveField(entry, 'amount')).toMatchObject({
      unavailableReason: expect.any(String),
    });
    expect(buildSchema([entry]).resolveField(entry, 'amount').display).not.toBe('42');
  },
);
it.each(['title', 'type', 'createdAt', 'modifiedAt'] as const)(
  'selected %s display uses the existing Entry fact precedence',
  (field) => {
    const entry = Object.assign(
      makeEntry({
        authority,
        title: 'Body H1',
        type: 'Task',
        createdAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-02-01T00:00:00Z',
      }),
      {
        canonicalProperties: {
          value: {
            kind: 'object',
            value: {
              type: { kind: 'string', value: 'Task' },
              title: { kind: 'string', value: 'Metadata caption' },
              createdAt: { kind: 'string', value: '2000-01-01T00:00:00Z' },
              modifiedAt: { kind: 'string', value: '2000-02-01T00:00:00Z' },
            },
          },
          unavailableLegacyKeys: [],
        } satisfies SelectedEntryProperties,
      },
    );
    const schema = buildSchema([entry]);
    expect(schema.resolveField(entry, field).raw).toBe(schema.fieldValue(entry, field));
    expect(schema.resolveField(entry, field)).not.toHaveProperty('selectedValue');
  },
);
