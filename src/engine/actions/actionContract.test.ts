import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { schemaToTypescript } from '../../../scripts/contracts/schemaToTypescript';
import cases from '../../../shared/actions/cases.v1.json';

function diagnostics(body: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), 'cerebro-actions-'));
  try {
    const file = join(directory, 'transport.ts');
    writeFileSync(
      file,
      `import type { ActionEffectDetails, ActionEffectRef, PrepareAction } from ${JSON.stringify(resolve('src/lib/generated/actions.ts'))};\n${body}`,
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

describe('Rust-owned action contract', () => {
  it('compiles shared effect details without confusing unavailable and empty values', () => {
    expect(
      diagnostics(
        `const details: ActionEffectDetails[] = ${JSON.stringify(cases.transportCases.map((row) => row.details))}; void details;`,
      ),
    ).toEqual([]);
    expect(
      diagnostics(`
// @ts-expect-error nullable fields are required on the wire
const missing: ActionEffectRef = { invocationId: 'i', state: 'outcome_unknown', canRetry: false, canReconcile: false };
// @ts-expect-error arbitrary outcome strings cannot claim completion
const state: ActionEffectRef['state'] = 'done';
// @ts-expect-error input is raw JSON text, never already rounded JS values
const input: PrepareAction['input'] = { value: 9007199254740993 };
void [missing, state, input];
`),
    ).toEqual([]);
  });
  it('shares the same reserved policy bytes as native validation', () => {
    expect(
      createHash('sha256').update(readFileSync('shared/policy/actions.v1.json')).digest('hex'),
    ).toBe(readFileSync('shared/policy/actions.v1.sha256', 'utf8').trim());
  });
  it('has a checked generated projection with exact nullable inspection fields', async () => {
    const schema: unknown = JSON.parse(readFileSync('shared/actions/contracts.v1.json', 'utf8'));
    expect(schema).toMatchObject({
      types: {
        ActionEffectDetails: {
          definitions: {
            SafeCounter: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          },
        },
      },
    });
    const source = readFileSync('src/lib/generated/actions.ts', 'utf8');
    expect(await schemaToTypescript(schema)).toBe(source);
    expect(source).toContain("'outcome_unknown'");
    expect(source).toContain('clientId: string | null');
    expect(source).not.toContain('export type ActionSubject =');
    expect(source).not.toContain('PersonActionDecision');
  });
  it('keeps shared canonical evidence distinct without a second browser validator', () => {
    expect(new Set(cases.canonicalCases.slice(0, 3).map((c) => c.canonical)).size).toBe(3);
    expect(cases.canonicalCases.find((c) => c.name === 'exact_precision')?.canonical).toContain(
      '9007199254740993',
    );
  });
});
