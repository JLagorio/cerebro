import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import CASES from '../../shared/workspace/values.v1.json';

/** Rust owns decoding and legacy patch semantics. This tests the generated
 * transport boundary, not a second browser interpreter of those rules. */
function diagnostics(body: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'cerebro-workspace-values-'));
  try {
    const file = join(directory, 'transport.ts');
    const contract = resolve('src/lib/generated/workspace.ts');
    writeFileSync(
      file,
      `import type { PropertyValue, PropertyChange } from ${JSON.stringify(contract)};\n${body}`,
    );
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      target: ts.ScriptTarget.ES2022,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      module: ts.ModuleKind.ESNext,
      allowImportingTsExtensions: true,
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('generated workspace value transport', () => {
  it('accepts every Rust shared value/change fixture without replacing decimals with numbers', () => {
    const values = [
      ...CASES.decodeCases.flatMap((row) => ('expected' in row ? [row.expected] : [])),
      ...CASES.taggedCases.filter((row) => row.valid).map((row) => row.value),
    ];
    const changes = CASES.changeCases.flatMap((row) => row.changes);
    expect(
      diagnostics(
        `const values: PropertyValue[] = ${JSON.stringify(values)};\nconst changes: PropertyChange[] = ${JSON.stringify(changes)};\nvoid [values, changes];`,
      ),
    ).toEqual([]);
  });

  it('keeps null and removal distinct and rejects rounded or untagged transport', () => {
    expect(
      diagnostics(`
const setNull: PropertyChange = { op: 'set', key: 'present', value: { kind: 'null' } };
const remove: PropertyChange = { op: 'remove', key: 'present' };
// @ts-expect-error Set must carry its value, including explicit null
const missing: PropertyChange = { op: 'set', key: 'present' };
// @ts-expect-error Remove does not smuggle a replacement value
const replacement: PropertyChange = { op: 'remove', key: 'present', value: { kind: 'null' } };
// @ts-expect-error a decimal is lexical text, never a JS number
const rounded: PropertyValue = { kind: 'decimal', value: 9007199254740993.125 };
// @ts-expect-error arrays retain tagged values recursively
const untagged: PropertyValue = { kind: 'array', value: [null, '007', 12] };
// @ts-expect-error resolved relations require a carried target identifier
const invented: PropertyValue = { kind: 'relation', spelling: '[[Unknown]]', resolution: { status: 'resolved' } };
void [setNull, remove, missing, replacement, rounded, untagged, invented];
`),
    ).toEqual([]);
  });
});
