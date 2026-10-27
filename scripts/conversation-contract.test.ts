import { resolve } from 'node:path';
import { it } from 'vitest';
import { generateContract } from './contracts/generate';

it('keeps conversation display transport generated from the Rust-owned schema', async () => {
  await generateContract(
    resolve('shared/conversations/contracts.v1.json'),
    resolve('src/lib/generated/conversations.ts'),
    true,
  );
});
