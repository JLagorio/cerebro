import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateContract } from './generate';

describe('contract regeneration and drift check', () => {
  it('generates once, checks without writing, and refuses stale output without repairing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cerebro-contract-check-'));
    try {
      const schema = join(root, 'schema.json');
      const output = join(root, 'output.ts');
      writeFileSync(schema, JSON.stringify({ version: 1, types: { Content: { type: 'string' } } }));
      await generateContract(schema, output, false);
      const generated = readFileSync(output, 'utf8');
      expect(generated).toContain('export type Content = string;');
      await generateContract(schema, output, true);
      expect(readFileSync(output, 'utf8')).toBe(generated);
      writeFileSync(output, `${generated}\n// stale\n`);
      await expect(generateContract(schema, output, true)).rejects.toThrow(/stale/);
      expect(readFileSync(output, 'utf8')).toBe(`${generated}\n// stale\n`);
      await generateContract(schema, output, false);
      expect(readFileSync(output, 'utf8')).toBe(generated);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not overwrite existing output when the Rust schema is unsupported', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cerebro-contract-unsupported-'));
    try {
      const schema = join(root, 'schema.json');
      const output = join(root, 'output.ts');
      writeFileSync(
        schema,
        JSON.stringify({ version: 1, types: { Content: { type: 'integer', format: 'uint64' } } }),
      );
      writeFileSync(output, 'keep existing contract\n');
      await expect(generateContract(schema, output, false)).rejects.toThrow(/unsupported/);
      expect(readFileSync(output, 'utf8')).toBe('keep existing contract\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
