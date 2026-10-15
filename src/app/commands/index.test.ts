import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseKeys } from '@/lib/keys/combo';
import {
  catalog,
  checkCatalog,
  commandDef,
  commandGroups,
  GROUPS,
  keyedCommands,
  orderGroups,
  scopesOf,
  type CommandDef,
} from './index';

const row = (over: Partial<CommandDef>): CommandDef => ({
  id: 'test.row',
  label: 'Row',
  keys: [],
  scope: 'app',
  group: 'General',
  ...over,
});

describe('the command catalog (M65.1)', () => {
  it('no command binds Escape', () => {
    for (const def of catalog()) {
      for (const spec of def.keys) {
        expect(parseKeys(spec).every((c) => c.key !== 'escape')).toBe(true);
      }
    }
    expect(() => checkCatalog([row({ keys: ['escape'] })])).toThrow(/Escape/);
    expect(() => checkCatalog([row({ keys: ['mod+esc'] })])).toThrow(/Escape/);
  });

  it('every id is unique', () => {
    const ids = catalog().map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(() => checkCatalog([row({}), row({})])).toThrow(/defined twice/);
  });

  it('a key is bound once per scope', () => {
    expect(() =>
      checkCatalog([
        row({ id: 'a', keys: ['mod+shift+k'] }),
        row({ id: 'b', keys: ['shift+mod+k'] }),
      ]),
    ).toThrow(/bound twice in scope app/);
    // The same key in two sibling scopes is fine.
    expect(() =>
      checkCatalog([
        row({ id: 'a', keys: ['j'], scope: 'page' }),
        row({ id: 'b', keys: ['j'], scope: 'peek' }),
      ]),
    ).not.toThrow();
  });

  it('an inner key equal to an outer one needs shadows, inner scopes included', () => {
    const app = row({ id: 'app.z', keys: ['mod+z'] });
    expect(() => checkCatalog([app, row({ id: 'p', keys: ['mod+z'], scope: 'page' })])).toThrow(
      /without shadows/,
    );
    expect(() =>
      checkCatalog([app, row({ id: 'p', keys: ['mod+z'], scope: 'page', shadows: ['app.z'] })]),
    ).not.toThrow();
    const page = row({ id: 'page.j', keys: ['j'], scope: 'page' });
    expect(() => checkCatalog([page, row({ id: 'v', keys: ['j'], scope: 'viewer' })])).toThrow(
      /reuses page's/,
    );
    expect(() =>
      checkCatalog([page, row({ id: 'v', keys: ['j'], scope: 'viewer', shadows: ['page.j'] })]),
    ).not.toThrow();
    // The shipped shadows hold: a diagram's undo shadows the app's.
    expect(commandDef('diagram.undo').shadows).toEqual(['undo']);
  });

  it('a letter is never inEditor or inModal', () => {
    expect(() => checkCatalog([row({ keys: ['j'], inEditor: true })])).toThrow(/letter/);
    expect(() => checkCatalog([row({ keys: ['shift+g'], inModal: true })])).toThrow(/letter/);
  });

  it('no inEditor command takes a key the editor keeps', () => {
    expect(() => checkCatalog([row({ keys: ['mod+b'], inEditor: true })])).toThrow(/editor/);
    for (const def of catalog()) {
      if (!def.inEditor) continue;
      for (const spec of def.keys) {
        const c = parseKeys(spec)[0];
        expect(['z', 'y', 'b', 'i', 'u', 'a', 'enter']).not.toContain(c.key);
      }
    }
  });

  it('an unparsable key throws', () => {
    expect(() => checkCatalog([row({ keys: ['hyper+k'] })])).toThrow(/unknown modifier/);
  });

  it('commandDef throws on an unknown id', () => {
    expect(() => commandDef('nope')).toThrow(/unknown command/);
    expect(scopesOf(commandDef('diagram.undo'))).toEqual(['page', 'peek', 'block']);
  });

  it("a file's own group follows GROUPS, in file order", () => {
    expect(commandGroups().slice(0, GROUPS.length)).toEqual(GROUPS);
    expect(orderGroups([undefined, 'Viewer', 'General', 'PDF', 'Viewer'])).toEqual([
      ...GROUPS,
      'Viewer',
      'PDF',
    ]);
  });

  it('keyedCommands lists rows with keys in group order', () => {
    const rows = keyedCommands();
    expect(rows.every((d) => d.keys.length > 0)).toBe(true);
    const order = commandGroups();
    const ranks = rows.map((d) => order.indexOf(d.group));
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });

  /**
   * A row with keys that nothing binds would show in Settings and do nothing.
   * Every keyed id must appear as a string literal in non-test source outside
   * this folder, the binding site.
   */
  it('every keyed command has a binding site', () => {
    const SRC = join(__dirname, '../..');
    const sources: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) sources.push(path);
      }
    };
    walk(SRC);
    const text = sources
      .filter((p) => !relative(SRC, p).startsWith(join('app', 'commands')))
      .map((p) => readFileSync(p, 'utf8'))
      .join('\n');
    const unbound = keyedCommands()
      .map((d) => d.id)
      .filter((id) => !text.includes(`'${id}'`));
    expect(unbound).toEqual([]);
  });
});
