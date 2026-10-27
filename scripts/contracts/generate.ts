import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { schemaToTypescript } from './schemaToTypescript';

export async function generateContract(
  schemaPath: string,
  outputPath: string,
  check: boolean,
): Promise<void> {
  const schema: unknown = JSON.parse(readFileSync(schemaPath, 'utf8'));
  const output = await schemaToTypescript(schema);
  if (check) {
    if (readFileSync(outputPath, 'utf8') !== output) {
      throw new Error(`stale generated contract: ${outputPath}`);
    }
    return;
  }
  writeFileSync(outputPath, output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: pnpm exec node --import tsx scripts/contracts/generate.ts [--check]');
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  await generateContract(
    resolve(root, 'shared/workspace/contracts.v1.json'),
    resolve(root, 'src/lib/generated/workspace.ts'),
    args[0] === '--check',
  );
  await generateContract(
    resolve(root, 'shared/actions/contracts.v1.json'),
    resolve(root, 'src/lib/generated/actions.ts'),
    args[0] === '--check',
  );
  await generateContract(
    resolve(root, 'shared/run-configuration/contracts.v1.json'),
    resolve(root, 'src/lib/generated/runConfiguration.ts'),
    args[0] === '--check',
  );
  await generateContract(
    resolve(root, 'shared/workflows/contracts.v1.json'),
    resolve(root, 'src/lib/generated/workflows.ts'),
    args[0] === '--check',
  );
  await generateContract(
    resolve(root, 'shared/conversations/contracts.v1.json'),
    resolve(root, 'src/lib/generated/conversations.ts'),
    args[0] === '--check',
  );
}
