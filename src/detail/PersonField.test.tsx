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

  /**
   * FLIPPED in M20.1. This used to assert the opposite — that a vault with no
   * notion of people offers EVERY record — on the reasoning that a long picker
   * beats a dead end. It is not merely long. `relationTargetFor` infers a
   * person field's target from the values it already holds, so picking the
   * Task below into `owner` made the field decide it points at Task, and
   * `peopleTypes` then reported Task as one of the vault's people types — in
   * every other untargeted person field, and in the editor's `@` menu. One
   * mis-click retyped the vault.
   *
   * The dead end was real and is closed by the create row below instead.
   */
  it('offers nothing rather than every record when the vault has no people', async () => {
    const user = userEvent.setup();
    setup('Teammate', { kind: 'person' });
    await user.click(screen.getAllByRole('button')[0]);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.queryByText('A task')).toBeNull();
  });

  /**
   * M20.1. Every other picker in the app could create its target and only this
   * one could not: a select cell offers "Create <label>", a relation cell
   * offers "Link or create a …", and a person cell said "No matches" and
   * stopped — which is why the candidate list used to fall back to the whole
   * vault. Creating the first person is also what ESTABLISHES what a person is
   * in a vault that has none, since the target is inferred back off the value
   * just written.
   */
  it('creates a person from the name typed into it', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('records/teammates/dana-fox.md');
    const patchFrontmatter = vi.fn().mockResolvedValue(undefined);
    setup('Teammate', { kind: 'person', target: 'Teammate' });
    useVaultStore.setState({ createItem, patchFrontmatter });
    await user.click(screen.getAllByRole('button')[0]);
    await user.type(screen.getByPlaceholderText(/Search/), 'Dana Fox');
    await user.click(screen.getByRole('button', { name: /Create Dana Fox/ }));
    expect(createItem).toHaveBeenCalledWith(
      expect.objectContaining({ frontmatter: { type: 'Teammate' }, slug: 'dana-fox' }),
    );
    // Linked by the stem it LANDED on — create_note may deduplicate the slug.
    expect(patchFrontmatter).toHaveBeenCalledWith('tasks/t1.md', { owner: ['[[dana-fox]]'] });
  });

  // With no target and no people at all, `Person` is the last-resort
  // convention `peopleTypes` already documents — the only place in the app
  // where that name is load-bearing, and only to establish the first one.
  it('creates a Person when the vault has no notion of people yet', async () => {
    const user = userEvent.setup();
    const createItem = vi.fn().mockResolvedValue('records/persons/dana-fox.md');
    setup('Teammate', { kind: 'person' });
    useVaultStore.setState({ createItem });
    await user.click(screen.getAllByRole('button')[0]);
    await user.type(screen.getByPlaceholderText(/Search/), 'Dana Fox');
    await user.click(screen.getByRole('button', { name: /Create Dana Fox/ }));
    expect(createItem).toHaveBeenCalledWith(
      expect.objectContaining({ frontmatter: { type: 'Person' } }),
    );
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
