// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as ipc from '@/lib/ipc';
import type { Entry } from '@/engine/types';
import { useVaultStore } from '@/stores/vaultStore';
import { makeEntry } from '@/test/factories';
import { AgentProperties } from './AgentProperties';

/**
 * An agent page's properties (M55.12; the M18 editor's tests moved here).
 *
 * The one rule they hold: **agent grants write on Done, never per keystroke.**
 * A boundary row writes nothing while its editor is open, then exactly its own
 * key(s) on Done; Cancel and Escape write nothing; and the value each key
 * reaches the file as is the value the editor drew — `[]` apart from null,
 * unknown names kept, `recent` never touched.
 */
const AGENT = makeEntry({
  path: 'records/agents/release-scout.md',
  folder: 'records/agents',
  title: 'Release scout',
  type: 'Agent',
  properties: {
    slug: 'release-scout',
    description: 'Watches risks',
    schedule: 'weekdays 08:30',
    scope: ['records/risks'],
    recent: 'Last run found two.',
  } as never,
});
const RISK = makeEntry({
  path: 'records/risks/rollback.md',
  folder: 'records/risks',
  title: 'Rollback unrehearsed',
  type: 'Risk',
  properties: { status: 'open' } as never,
});

const patch = vi.fn(async (_path: string, _patch: Record<string, unknown>) => true);

/** The page's host: the entry as the store holds it, so a rescan re-renders. */
function Host({ path = AGENT.path }: { path?: string }) {
  const entry = useVaultStore((s) => s.entries.find((e) => e.path === path));
  return entry === undefined ? null : <AgentProperties entry={entry} />;
}

function setup(entries: Entry[] = [AGENT, RISK], path?: string) {
  useVaultStore.setState({
    vaultPath: '/vault',
    entries,
    patchFrontmatter: patch as never,
  });
  render(<Host path={path} />);
}

const row = (key: string) => screen.getByTestId(`agent-prop-${key}`);
const openRow = (key: string) => {
  fireEvent.click(within(row(key)).getByTestId('agent-prop-open'));
  return screen.getByTestId(`agent-editor-${key}`);
};
const done = (editor: HTMLElement) =>
  fireEvent.click(within(editor).getByRole('button', { name: 'Done' }));
const lastPatch = () => patch.mock.calls.at(-1)?.[1];

afterEach(cleanup);

describe('AgentProperties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patch.mockResolvedValue(true);
  });

  it('a trigger built clause by clause writes nothing until Done, then exactly when:', async () => {
    setup();
    fireEvent.click(screen.getByTestId('agent-add-trigger'));
    const editor = screen.getByTestId('agent-editor-trigger-new');
    fireEvent.change(within(editor).getByLabelText('Trigger 1 event'), {
      target: { value: 'created' },
    });
    fireEvent.change(within(editor).getByLabelText('Trigger 1 field'), {
      target: { value: 'status' },
    });
    fireEvent.change(within(editor).getByLabelText('Trigger 1 value'), {
      target: { value: 'open' },
    });
    // A bare `{event: changed}` is valid and fires on every change, so no
    // clause reaches the file before Done.
    expect(patch).not.toHaveBeenCalled();
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][0]).toBe(AGENT.path);
    expect(lastPatch()).toEqual({ when: [{ event: 'created', field: 'status', to: 'open' }] });
    await waitFor(() => expect(screen.queryByTestId('agent-editor-trigger-new')).toBeNull());
  });

  it('Cancel and Escape write nothing', async () => {
    setup();
    let editor = openRow('scope');
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove records/risks' }));
    fireEvent.click(within(editor).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('agent-editor-scope')).toBeNull();

    editor = openRow('scope');
    // Seeded afresh from the record: the discarded edit is gone.
    expect(within(editor).getByRole('button', { name: 'Remove records/risks' })).toBeTruthy();
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove records/risks' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('agent-editor-scope')).toBeNull();

    fireEvent.click(screen.getByTestId('agent-add-trigger'));
    fireEvent.click(
      within(screen.getByTestId('agent-editor-trigger-new')).getByRole('button', {
        name: 'Cancel',
      }),
    );
    expect(patch).not.toHaveBeenCalled();
  });

  it('a click elsewhere neither writes nor discards', () => {
    setup();
    const editor = openRow('scope');
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove records/risks' }));
    fireEvent.pointerDown(document.body);
    fireEvent.click(document.body);
    expect(screen.getByTestId('agent-editor-scope')).toBeTruthy();
    expect(within(editor).queryByRole('button', { name: 'Remove records/risks' })).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });

  it('each Done writes only its own keys', async () => {
    setup();
    done(openRow('shell'));
    // Unchanged: Done just closes.
    expect(patch).not.toHaveBeenCalled();

    let editor = openRow('shell');
    fireEvent.click(within(editor).getByRole('checkbox'));
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(lastPatch()).toEqual({ tools: 'shell' });

    editor = openRow('identity');
    fireEvent.change(within(editor).getByTestId('agent-slug'), {
      target: { value: 'Release Watch' },
    });
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(lastPatch()).toEqual({ slug: 'release-watch' });

    editor = openRow('tools');
    fireEvent.click(
      within(editor).getByRole('checkbox', { name: /Restrict this agent to specific tools/ }),
    );
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(3));
    expect(lastPatch()).toEqual({ 'allowed-tools': [] });
  });

  it('scoping to nothing writes [], and un-scoping writes null', async () => {
    // [] and absent are opposite instructions; a row that collapsed them
    // would turn the safest-looking declaration into the most dangerous one.
    setup();
    let editor = openRow('scope');
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove records/risks' }));
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(lastPatch()).toEqual({ scope: [] });

    editor = openRow('scope');
    fireEvent.click(
      within(editor).getByRole('checkbox', { name: /Limit where this agent can write/ }),
    );
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2));
    expect(lastPatch()).toEqual({ scope: null });
  });

  it('offers folders that EXIST, with what is in them', () => {
    // The complaint that started M18.4: a text box accepted a folder that
    // does not exist and scoped the agent to nothing, silently.
    setup();
    const editor = openRow('scope');
    fireEvent.click(within(within(editor).getByTestId('agent-scope')).getByTestId('picker-add'));
    const labels = screen.getAllByTestId('picker-option').map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('records/risks'))).toBe(true);
    expect(labels.some((l) => l?.includes('records/agents'))).toBe(true);
    // Ancestors too — `records` is a legitimate scope even when every file
    // lives two levels down.
    expect(labels).toContain('records2');
  });

  it('picks tools from the catalog, a whole toolset in one click, and says whether it can write', async () => {
    setup();
    const editor = openRow('tools');
    fireEvent.click(
      within(editor).getByRole('checkbox', { name: /Restrict this agent to specific tools/ }),
    );
    fireEvent.click(within(screen.getByTestId('agent-allowed-tools')).getByTestId('picker-add'));
    const labels = screen.getAllByTestId('picker-option').map((o) => o.textContent);
    expect(labels.some((l) => l?.includes('search_notes'))).toBe(true);
    expect(labels.some((l) => l?.includes('write_concept'))).toBe(true);
    const readGroup = screen
      .getAllByTestId('picker-group')
      .find((g) => g.textContent?.includes('Read the vault'));
    fireEvent.click(readGroup!);
    expect(screen.getByTestId('agent-tools-summary').textContent).toContain('Read-only');
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(lastPatch()).toEqual({
      'allowed-tools': [
        'get_vault_context',
        'search_notes',
        'get_note',
        'knowledge_about',
        'list_inbox',
      ],
    });
  });

  it('keeps a tool name it does not recognise, and says it does not', () => {
    const odd = makeEntry({
      path: 'records/agents/odd.md',
      folder: 'records/agents',
      type: 'Agent',
      title: 'Odd',
      properties: { 'allowed-tools': ['get_note', 'delete_everything'] } as never,
    });
    setup([odd], odd.path);
    expect(row('tools').textContent).toContain('2 granted: get_note, delete_everything');
    const editor = openRow('tools');
    expect(within(editor).getByText(/not something this vault has/)).toBeTruthy();
    expect(
      within(editor)
        .getAllByTestId('picker-chip')
        .map((c) => c.textContent),
    ).toEqual(['get_note', 'delete_everything']);
  });

  it('builds a schedule instead of asking for its grammar, and writes it alone', async () => {
    setup();
    const editor = openRow('schedule');
    const repeat = within(editor).getByLabelText('Repeat') as HTMLSelectElement;
    expect(repeat.value).toBe('weekdays');
    fireEvent.change(repeat, { target: { value: 'weekly' } });
    fireEvent.change(within(editor).getByLabelText('Day'), { target: { value: '5' } });
    fireEvent.change(within(editor).getByTestId('schedule-time'), { target: { value: '17:30' } });
    expect(patch).not.toHaveBeenCalled();
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(lastPatch()).toEqual({ schedule: 'weekly fri 17:30' });
  });

  it('a schedule-less agent says what fires it, or that nothing does (M52.4)', () => {
    const bare = makeEntry({
      path: 'records/agents/bare.md',
      folder: 'records/agents',
      type: 'Agent',
      title: 'Bare',
    });
    const triggered = makeEntry({
      path: 'records/agents/triggered.md',
      folder: 'records/agents',
      type: 'Agent',
      title: 'Triggered',
      properties: { when: ['created'] } as never,
    });
    setup([bare, triggered], bare.path);
    expect(row('schedule').textContent).toContain('none — off duty, runs only when you ask');
    cleanup();
    setup([bare, triggered], triggered.path);
    expect(row('schedule').textContent).toContain('none — its triggers fire it');
    expect(screen.getAllByTestId('agent-trigger-line')).toHaveLength(1);
  });

  it('the closed rows say what the file says', () => {
    setup();
    expect(row('identity').textContent).toContain('process:release-scout');
    expect(row('identity').textContent).toContain('fixed');
    expect(row('scope').textContent).toContain('records/risks/');
    expect(row('read-scope').textContent).toContain('everything');
    expect(row('tools').textContent).toContain('unrestricted');
    expect(row('shell').textContent).toContain('off');
    expect(row('schedule').textContent).toContain('weekdays 08:30');
  });

  it('a refused write keeps the editor open with its draft', async () => {
    patch.mockResolvedValueOnce(false);
    setup();
    const editor = openRow('scope');
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove records/risks' }));
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('agent-editor-scope')).toBeTruthy();
    expect(
      within(screen.getByTestId('agent-scope')).queryByRole('button', {
        name: 'Remove records/risks',
      }),
    ).toBeNull();
  });

  it('a rescan keeps an open draft', () => {
    setup();
    const editor = openRow('scope');
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove records/risks' }));
    // A background rescan lands a new object for the same record.
    act(() =>
      useVaultStore.setState({
        entries: [
          { ...AGENT, properties: { ...AGENT.properties, description: 'Rescanned' } },
          RISK,
        ],
      }),
    );
    // The page re-rendered from the new object…
    expect((screen.getByTestId('agent-description') as HTMLInputElement).value).toBe('Rescanned');
    // …and the open draft is still the one being built.
    expect(screen.getByTestId('agent-editor-scope')).toBeTruthy();
    expect(
      within(screen.getByTestId('agent-scope')).queryByRole('button', {
        name: 'Remove records/risks',
      }),
    ).toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });

  it('the description commits on blur, and only when it changed', async () => {
    setup();
    const input = screen.getByTestId('agent-description');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(patch).not.toHaveBeenCalled();

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Watches everything' } });
    expect(patch).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.blur(input);
    expect(patch).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe('Watches risks');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'Watches everything' } });
    fireEvent.blur(input);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(lastPatch()).toEqual({ description: 'Watches everything' });
  });

  it('never writes the agent’s own notes', async () => {
    setup();
    const editor = openRow('scope');
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove records/risks' }));
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalled());
    for (const [, written] of patch.mock.calls) expect('recent' in written).toBe(false);
  });

  it('says when this vault has no connectors enabled', () => {
    setup();
    expect(row('connectors').textContent).toContain(
      'none on its own; every approved one when you address it',
    );
    const editor = openRow('connectors');
    fireEvent.click(
      within(editor).getByRole('checkbox', { name: /Limit which connectors this agent can reach/ }),
    );
    expect(within(editor).getByText(/This vault has no connectors enabled/)).toBeTruthy();
  });
});

/**
 * M54.9 — connectors are granted by name, so the tool picker offers them, a
 * single connector tool already in the file is a known chip, and the record's
 * `disallowed-tools:` is shown and never written.
 */
describe('AgentProperties connector tools (M54.9)', () => {
  const MAILER = makeEntry({
    path: 'records/agents/mailer.md',
    folder: 'records/agents',
    title: 'Mailer',
    type: 'Agent',
    properties: {
      slug: 'mailer',
      connectors: ['gmail'],
      'allowed-tools': ['search_notes', 'mcp__gmail__search_threads'],
      'disallowed-tools': ['mcp__gmail__trash_thread'],
    } as never,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    patch.mockResolvedValue(true);
    // The browser backend's connector list, read by the rows on open.
    await ipc.saveConnectors(
      '/vault',
      JSON.stringify({
        servers: {
          gmail: { transport: 'http', url: 'https://gmail.example.test/mcp', enabled: true },
          slack: { transport: 'http', url: 'https://slack.example.test/mcp', enabled: true },
          off: { transport: 'http', url: 'https://off.example.test/mcp', enabled: false },
        },
      }),
    );
  });

  afterEach(async () => {
    await ipc.saveConnectors('/vault', '');
  });

  it('offers every tool of each enabled connector as one option', async () => {
    setup([MAILER], MAILER.path);
    const editor = openRow('tools');
    fireEvent.click(
      within(within(editor).getByTestId('agent-allowed-tools')).getByTestId('picker-add'),
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('picker-option').map((o) => o.textContent ?? '')).toEqual(
        expect.arrayContaining([expect.stringMatching(/^Every gmail tool/)]),
      ),
    );
    const offered = screen
      .getAllByTestId('picker-option')
      .map((o) => o.textContent ?? '')
      .filter((label) => label.startsWith('Every '));
    expect(offered.map((label) => label.split(' tool')[0])).toEqual(['Every gmail', 'Every slack']);
  });

  it('knows a single connector tool, and says connector tools reach outside the vault', async () => {
    setup([MAILER], MAILER.path);
    const editor = openRow('tools');
    const tools = within(editor).getByTestId('agent-allowed-tools');
    await waitFor(() => {
      const chip = within(tools)
        .getAllByTestId('picker-chip')
        .find((c) => c.textContent?.includes('search_threads (gmail)'));
      expect(chip?.getAttribute('data-unknown')).toBe('false');
    });
    expect(within(tools).queryByText(/not something this vault has/)).toBeNull();
    const summary = screen.getByTestId('agent-tools-summary').textContent ?? '';
    expect(summary).toContain('Read-only');
    expect(summary).toContain('Connector tools can change things outside your vault.');
  });

  it('says a connector tool does nothing on a schedule until the connector is named', async () => {
    // An unattended run reaches only the connectors its record names (Q8).
    const loose = {
      ...MAILER,
      properties: { slug: 'mailer', 'allowed-tools': ['mcp__gmail'] } as never,
    };
    setup([loose], MAILER.path);
    openRow('tools');
    await waitFor(() =>
      expect(screen.getByTestId('agent-tools-summary').textContent).toContain(
        'On its own it reaches none of them until you name the connector below.',
      ),
    );
  });

  it('the connectors row picks from enabled connectors and writes only connectors:', async () => {
    setup([MAILER], MAILER.path);
    expect(row('connectors').textContent).toContain('gmail');
    const editor = openRow('connectors');
    const picker = await within(editor).findByTestId('agent-connectors');
    fireEvent.click(within(picker).getByTestId('picker-add'));
    const labels = screen.getAllByTestId('picker-option').map((o) => o.textContent ?? '');
    expect(labels.some((l) => l.startsWith('slack'))).toBe(true);
    expect(labels.some((l) => l.startsWith('off'))).toBe(false);
    fireEvent.click(within(picker).getByRole('button', { name: 'Remove gmail' }));
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(lastPatch()).toEqual({ connectors: [] });
  });

  it('shows what the record never calls, and no write touches it', async () => {
    setup([MAILER], MAILER.path);
    expect(screen.getByTestId('agent-never-calls').textContent).toContain(
      'Never calls: mcp__gmail__trash_thread',
    );
    const editor = openRow('tools');
    fireEvent.click(within(editor).getByRole('button', { name: 'Remove search_notes' }));
    done(editor);
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(lastPatch()).toEqual({ 'allowed-tools': ['mcp__gmail__search_threads'] });
  });
});
