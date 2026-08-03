// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FieldEditor } from '@/detail/FieldEditor';
import { buildSchema } from '@/engine/schema';
import type { Entry, FieldDef } from '@/engine/types';
import { resetLayers } from '@/components/ui/layers';
import { useUiStore } from '@/stores/uiStore';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';

/**
 * A person field picks from records (M16.13b).
 *
 * It used to pick from `entries.filter((e) => e.type === 'Person')` — routing
 * on a type NAME, which AGENTS.md forbids and which left a vault whose people
 * are `Teammate`s with an empty picker and no control anywhere to fix it.
 */
function setup(
  peopleType: string,
  fieldSpec: Record<string, unknown> = { kind: 'person' },
  /** A sibling record that already holds a person — what value inference
   * reads when nobody declared a target. */
  held: string[] = [],
) {
  const entries: Entry[] = [
    makeEntry({
      path: 'types/task.md',
      title: 'Task',
      type: 'Type',
      properties: { fields: { owner: fieldSpec } } as unknown as Entry['properties'],
    }),
    makeEntry({ path: `types/${peopleType.toLowerCase()}.md`, title: peopleType, type: 'Type' }),
    makeEntry({ path: 'people/ana-rios.md', title: 'Ana Rios', type: peopleType }),
    makeEntry({ path: 'people/bo-chen.md', title: 'Bo Chen', type: peopleType }),
    ...(held.length === 0
      ? []
      : [
          makeEntry({
            path: 'tasks/t0.md',
            title: 'An older task',
            type: 'Task',
            relationships: { owner: held },
          }),
        ]),
    makeEntry({ path: 'tasks/t1.md', title: 'A task', type: 'Task' }),
  ];
  const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
  useVaultStore.setState({ entries, vaultPath: '/vault', patchFrontmatter });
  const schema = buildSchema(entries);
  const record = entries[entries.length - 1];
  const def = schema.types.get('Task')?.fields.find((f) => f.name === 'owner') as FieldDef;
  render(<FieldEditor entry={record} def={def} schema={schema} />);
  return { patchFrontmatter };
}

describe('person field candidates', () => {
  beforeEach(() => {
    resetLayers();
    useUiStore.setState({ toasts: [] });
  });
  afterEach(cleanup);

  it('offers the declared target’s records, whatever that type is called', async () => {
    const user = userEvent.setup();
    setup('Teammate', { kind: 'person', target: 'Teammate' });
    await user.click(screen.getAllByRole('button')[0]);
    expect(screen.getByRole('option', { name: /Ana Rios/ })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Bo Chen/ })).toBeTruthy();
  });

  // The bug, exactly: no target declared, and no type named Person anywhere.
  // The old code returned zero candidates and there was no control in the app
  // that could change that.
  it('infers the target from the people the type already holds', async () => {
    const user = userEvent.setup();
    setup('Teammate', { kind: 'person' }, ['ana-rios']);
    await user.click(screen.getAllByRole('button')[0]);
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toEqual(['Ana Rios', 'Bo Chen']);
  });

  // Better a picker with everything in it than the dead end this used to be.
  it('offers every record when the vault has no notion of people at all', async () => {
    const user = userEvent.setup();
    setup('Teammate', { kind: 'person' });
    await user.click(screen.getAllByRole('button')[0]);
    const names = screen.getAllByRole('option').map((o) => o.textContent);
    expect(names).toContain('Ana Rios');
    expect(names).toContain('A task');
    // Type docs are schema, never candidates.
    expect(names).not.toContain('Teammate');
  });

  it('writes the picked record as a wikilink', async () => {
    const user = userEvent.setup();
    const { patchFrontmatter } = setup('Teammate', { kind: 'person', target: 'Teammate' });
    await user.click(screen.getAllByRole('button')[0]);
    await user.click(screen.getByRole('option', { name: /Ana Rios/ }));
    expect(patchFrontmatter).toHaveBeenCalledWith('tasks/t1.md', { owner: ['[[ana-rios]]'] });
  });

  it('still works for a vault that does call them People', async () => {
    const user = userEvent.setup();
    setup('Person');
    await user.click(screen.getAllByRole('button')[0]);
    expect(screen.getByRole('option', { name: /Ana Rios/ })).toBeTruthy();
  });
});
