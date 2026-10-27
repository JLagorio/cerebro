import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { schemaToTypescript } from './schemaToTypescript';

const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const bundle = (schema: unknown) => ({ version: 1, types: { Example: schema } });

function diagnostics(source: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'cerebro-contract-types-'));
  try {
    const file = join(directory, 'contract.ts');
    writeFileSync(file, source);
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('Rust schema projection', () => {
  it('preserves recursive typed dictionaries and nullable schema type arrays', async () => {
    const projected = await schemaToTypescript({
      version: 1,
      types: {
        Value: {
          oneOf: [
            object({ kind: { type: 'string', enum: ['text'] }, value: { type: 'string' } }),
            object({
              kind: { type: 'string', enum: ['map'] },
              value: { type: 'object', additionalProperties: { $ref: '#/definitions/Value' } },
            }),
          ],
        },
        Maybe: { type: ['string', 'null'] },
      },
    });
    expect(
      diagnostics(`${projected}
const value: Value = { kind: 'map', value: { unknown: { kind: 'text', value: '007' } } };
const nullable: Maybe = null;
// @ts-expect-error map members retain the recursive value contract
const wrong: Value = { kind: 'map', value: { unknown: 3 } };
// @ts-expect-error nullable strings do not widen to numeric values
const numeric: Maybe = 3;
void [value, nullable, wrong, numeric];
`),
    ).toEqual([]);
  });

  it('keeps required fields, nullable values, literal enums, arrays and local references typed', async () => {
    const schema = {
      ...object(
        {
          content: { type: 'string' },
          ok: { type: 'boolean' },
          reason: { anyOf: [{ $ref: '#/definitions/Reason' }, { type: 'null' }] },
          tags: { type: 'array', items: { type: 'string' } },
        },
        ['content', 'ok', 'tags'],
      ),
      definitions: { Reason: { type: 'string', enum: ['missing', 'refused'] } },
    };
    const projected = await schemaToTypescript(bundle(schema));
    expect(
      diagnostics(`${projected}
const good: Example = { content: '', ok: true, tags: [] };
const nullable: Example = { ...good, reason: null };
const named: Example = { ...good, reason: 'refused' };
// @ts-expect-error required content cannot disappear
const missing: Example = { ok: true, tags: [] };
// @ts-expect-error a string error cannot turn into success-shaped data
const wrong: Example = { content: 0, ok: true, tags: [] };
// @ts-expect-error a closed literal cannot widen to string
const widened: Example = { ...good, reason: 'invented' };
// @ts-expect-error arrays retain their element type
const array: Example = { ...good, tags: [3] };
void [nullable, named, missing, wrong, widened, array];
`),
    ).toEqual([]);
  });

  it('preserves tagged enum branches rather than making every branch field optional', async () => {
    const projected = await schemaToTypescript(
      bundle({
        oneOf: [
          object({ kind: { type: 'string', enum: ['ok'] }, value: { type: 'string' } }),
          object({ kind: { type: 'string', enum: ['failed'] }, retryable: { type: 'boolean' } }),
        ],
      }),
    );
    expect(
      diagnostics(`${projected}
const success: Example = { kind: 'ok', value: '' };
const failure: Example = { kind: 'failed', retryable: false };
// @ts-expect-error a success must carry its value
const incomplete: Example = { kind: 'ok' };
// @ts-expect-error branch fields do not leak across the discriminant
const mixed: Example = { kind: 'failed', value: '' };
void [success, failure, incomplete, mixed];
`),
    ).toEqual([]);
  });

  it.each([
    { type: 'integer', format: 'uint64' },
    { type: 'string', pattern: '^x' },
    { $ref: 'https://example.test/schema.json' },
    { $ref: '#/definitions/Missing' },
    { type: 'object', additionalProperties: true },
    { type: 'object', additionalProperties: { type: 'number' } },
    { type: 'object', properties: {}, additionalProperties: { type: 'string' } },
    { type: [] },
    { type: ['string', 'string'] },
    { type: ['string', 'number'] },
    { type: 'array', items: [{ type: 'string' }] },
    { allOf: [{ type: 'string' }] },
    true,
  ])(
    'refuses unsupported or unresolved schema without an any/unknown fallback: %j',
    async (schema) => {
      await expect(schemaToTypescript(bundle(schema))).rejects.toThrow(/unsupported|unresolved/);
    },
  );

  it('refuses conflicting definitions and invalid exported identifiers', async () => {
    await expect(
      schemaToTypescript({
        version: 1,
        types: {
          A: { type: 'string', definitions: { Shared: { type: 'string' } } },
          B: { type: 'boolean', definitions: { Shared: { type: 'boolean' } } },
        },
      }),
    ).rejects.toThrow(/conflicting/);
    await expect(
      schemaToTypescript({ version: 1, types: { 'Bad;Name': { type: 'string' } } }),
    ).rejects.toThrow(/identifier/);
  });

  it('shares a type exported as a root and referenced by another Rust DTO', async () => {
    const projected = await schemaToTypescript({
      version: 1,
      types: {
        Identity: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          title: 'Identity',
          ...object({ path: { type: 'string' }, active: { type: 'boolean' } }),
        },
        Snapshot: {
          ...object({ identity: { $ref: '#/definitions/Identity' } }),
          definitions: {
            Identity: object({ active: { type: 'boolean' }, path: { type: 'string' } }),
          },
        },
      },
    });
    expect(
      diagnostics(
        `${projected}\nconst value: Snapshot = { identity: { path: '', active: true } };\nvoid value;`,
      ),
    ).toEqual([]);
    expect(projected.match(/export type Identity/g)).toHaveLength(1);
  });

  it('does not mistake fields named title or description for schema annotations', async () => {
    await expect(
      schemaToTypescript({
        version: 1,
        types: {
          Identity: object({ title: { type: 'string' } }),
          Snapshot: {
            ...object({ identity: { $ref: '#/definitions/Identity' } }),
            definitions: {
              Identity: object({ title: { type: 'boolean' } }),
            },
          },
        },
      }),
    ).rejects.toThrow(/conflicting/);
  });

  it('emits identical bytes independent of schema map insertion order', async () => {
    const a = {
      version: 1,
      types: {
        Zebra: object({ z: { type: 'boolean' }, a: { type: 'string' } }),
        Alpha: { type: 'string' },
      },
    };
    const b = {
      version: 1,
      types: {
        Alpha: { type: 'string' },
        Zebra: object({ a: { type: 'string' }, z: { type: 'boolean' } }),
      },
    };
    expect(await schemaToTypescript(a)).toBe(await schemaToTypescript(b));
  });
});
