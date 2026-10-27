import { expect, it } from 'vitest';
import { schemaToTypescript } from './schemaToTypescript';
it('projects only bounded exact nonnegative integer numbers', async () => {
  const bundle = (schema: unknown) => ({ version: 1, types: { Revision: schema } });
  await expect(
    schemaToTypescript(bundle({ type: 'integer', minimum: 0, maximum: 9007199254740991 })),
  ).resolves.toContain('export type Revision = number');
  for (const schema of [
    { type: 'integer' },
    { type: 'integer', minimum: 0, maximum: 9007199254740992 },
    { type: 'number' },
    { type: 'integer', minimum: 0, maximum: 10, format: 'uint64' },
  ]) {
    await expect(schemaToTypescript(bundle(schema))).rejects.toThrow('unsupported');
  }
});
