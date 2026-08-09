/**
 * M22.7 soak, distiller half: migration writes EVENTS, never files, so a
 * learn-attempts ledger that was caught up before migration is still caught
 * up after it — the distiller queue stays cold.
 *
 * The Rust soak (`src-tauri/src/ledger/soak.rs`) proves the file half:
 * byte-identical projection and untouched mtimes on a demo-vault copy. The
 * queue is a pure function of entries (mtimes included), concepts, and the
 * attempts ledger, so this test seeds the ledger the distiller actually
 * consults with the scanned demo-vault state and asserts emptiness — the
 * exact inputs an app relaunch after migration would derive.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { learnQueue } from '@/engine/learn';
import { listConcepts } from '@/engine/okf';
import { resetMockFs, scanVault } from '@/lib/mockIpc';

const TODAY = '2026-08-08';

describe('migration leaves the distiller queue cold', () => {
  beforeEach(() => {
    resetMockFs();
  });

  it('a caught-up learnAttempts ledger stays empty after scan', async () => {
    const entries = await scanVault('demo-vault');
    const concepts = listConcepts(entries, TODAY);

    // The pre-seeded localStorage learnAttempts ledger: every note recorded
    // at exactly its current modifiedAt — the distiller has read the world
    // as it stands. Migration changes no file and no mtime, so this ledger
    // survives it verbatim.
    const attempts: Record<string, string> = {};
    for (const entry of entries) attempts[entry.path] = entry.modifiedAt;
    for (const concept of concepts) attempts[concept.entry.path] = concept.entry.modifiedAt;

    const queue = learnQueue(entries, concepts, { filed: [], attempts });
    expect(queue).toEqual([]);
  });

  it('the queue is non-trivially guarded — an mtime bump WOULD wake it', async () => {
    // The control: the emptiness above is the attempts ledger doing its
    // job, not the queue being vacuously empty. Aging one stale concept
    // past its recorded attempt produces work again.
    const entries = await scanVault('demo-vault');
    const concepts = listConcepts(entries, TODAY);
    const attempts: Record<string, string> = {};
    for (const entry of entries) attempts[entry.path] = entry.modifiedAt;
    for (const concept of concepts) attempts[concept.entry.path] = concept.entry.modifiedAt;

    const stale = concepts.find((c) => c.stale && c.supersededBy === null);
    expect(stale).toBeDefined();
    attempts[stale!.entry.path] = '1999-01-01T00:00:00Z';
    const queue = learnQueue(entries, concepts, { filed: [], attempts });
    expect(queue.length).toBeGreaterThan(0);
  });
});
