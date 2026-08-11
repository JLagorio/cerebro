import { describe, expect, it } from 'vitest';
import type { Entry } from '@/engine/types';
import { parseFlowchart } from '@/mermaid/flowchart/model';
import { makeEntry } from '@/test/factories';
import {
  insertRecordNode,
  modelRecordBindings,
  recordBindings,
  resolveBinding,
} from './whiteboardBindings';

const ENTRIES = [
  makeEntry({ path: 'delivery/ship-v2.md', title: 'Ship v2', type: 'Work item' }),
  makeEntry({ path: 'delivery/beta.md', title: 'Beta program', type: 'Work item' }),
];

describe('resolveBinding', () => {
  it('resolves an exact vault path first', () => {
    expect(resolveBinding('delivery/ship-v2.md', ENTRIES)?.title).toBe('Ship v2');
  });

  it('falls back to wikilink resolution for hand-authored targets', () => {
    // resolveTarget's stem pass: `ship-v2` names delivery/ship-v2.md.
    expect(resolveBinding('ship-v2', ENTRIES)?.title).toBe('Ship v2');
  });

  it('a URL, a scheme, or an unknown target binds nothing', () => {
    expect(resolveBinding('https://example.com', ENTRIES)).toBeNull();
    // A scheme is never a vault path, even if some record were titled after it
    // — the same `isVaultPath` reading the link badge classifies targets with.
    expect(resolveBinding('mailto:ship-v2', ENTRIES)).toBeNull();
    expect(resolveBinding('nope/missing.md', ENTRIES)).toBeNull();
    expect(resolveBinding('   ', ENTRIES)).toBeNull();
  });
});

describe('recordBindings', () => {
  it('maps bound node ids to their entries and skips unresolved clicks', () => {
    const code = [
      'flowchart TD',
      '  a[Ship v2]',
      '  b[Elsewhere]',
      '  click a "delivery/ship-v2.md"',
      '  click b "https://example.com"',
    ].join('\n');
    const map = recordBindings(code, ENTRIES);
    expect(map.get('a')?.entry.title).toBe('Ship v2');
    expect(map.get('a')?.target).toBe('delivery/ship-v2.md');
    expect(map.has('b')).toBe(false);
  });

  it('returns empty for source that is not a flowchart', () => {
    expect(recordBindings('sequenceDiagram\n  A->>B: x', ENTRIES).size).toBe(0);
  });

  it('the model form answers identically — it is the same reader, minus a parse', () => {
    const code = 'flowchart TD\n  a[Ship v2]\n  click a "delivery/ship-v2.md"\n';
    expect(modelRecordBindings(parseFlowchart(code)!, ENTRIES)).toEqual(
      recordBindings(code, ENTRIES),
    );
  });

  it('the last owned click line wins, exactly as mermaid resolves it', () => {
    const code = [
      'flowchart TD',
      '  a[Ship v2]',
      '  click a "delivery/beta.md"',
      '  click a "delivery/ship-v2.md"',
    ].join('\n');
    expect(recordBindings(code, ENTRIES).get('a')?.entry.title).toBe('Ship v2');
  });

  it('flags a binding an unowned click statement also writes', () => {
    // `href` writes the very same link slot and, being last, is what mermaid
    // actually applies — so the chip says "Ship v2" while the picture may open
    // something else. `nodeLinks` is the one reader that knows; a chip that
    // did its own line walk would not.
    const code = [
      'flowchart TD',
      '  a[Ship v2]',
      '  click a "delivery/ship-v2.md"',
      '  click a href "https://elsewhere.example"',
    ].join('\n');
    expect(recordBindings(code, ENTRIES).get('a')?.contested).toBe(true);
  });

  it('a node linked ONLY by an unowned variant is absent — absent is not unlinked', () => {
    // The whole trap: the model carries no click line we own, so there is no
    // target to resolve and no chip to draw. "Not in this map" means "no link
    // this editor can read", never "this node has no link".
    const code = ['flowchart TD', '  a[Ship v2]', '  click a href "delivery/ship-v2.md"'].join(
      '\n',
    );
    expect(recordBindings(code, ENTRIES).size).toBe(0);
  });
});

/** The inserted source, or a failure the assertion names. */
const inserted = (code: string, target: Entry): string => {
  const result = insertRecordNode(code, target);
  if (!result.ok) throw new Error(`expected an insertion, got refusal: ${result.reason}`);
  return result.code;
};

describe('insertRecordNode', () => {
  it('adds a titled node and its click binding in ONE new source', () => {
    const next = inserted('flowchart TD\n', ENTRIES[0]);
    // One string carries both halves — that is what makes the insertion one
    // onChangeCode and therefore one undo step (spec D10). There is no
    // intermediate source in which the node exists unbound.
    expect(next).toContain('Ship v2');
    expect(next).toContain('click');
    expect(next).toContain('delivery/ship-v2.md');
    // The result re-parses and the binding resolves — the round trip is the contract.
    const bound = [...recordBindings(next, ENTRIES).values()];
    expect(bound).toHaveLength(1);
    expect(bound[0].entry.path).toBe('delivery/ship-v2.md');
    expect(bound[0].contested).toBe(false);
  });

  it('leaves the source it was given untouched', () => {
    const code = 'flowchart TD\n';
    insertRecordNode(code, ENTRIES[0]);
    expect(code).toBe('flowchart TD\n');
  });

  it('a second record lands beside the first with its own id', () => {
    const bound = recordBindings(
      inserted(inserted('flowchart TD\n', ENTRIES[0]), ENTRIES[1]),
      ENTRIES,
    );
    expect(bound.size).toBe(2);
    expect([...bound.values()].map((b) => b.entry.path).sort()).toEqual([
      'delivery/beta.md',
      'delivery/ship-v2.md',
    ]);
  });

  it('a title mermaid cannot take bare still round-trips', () => {
    // `@` and `"` are parse errors unquoted (emit.ts quoteLabel); a record
    // titled with either must not be able to kill the canvas it is dropped on.
    const awkward = makeEntry({ path: 'delivery/at.md', title: 'Ship @ 5pm "hard"' });
    const bound = [...recordBindings(inserted('flowchart TD\n', awkward), [awkward]).values()];
    expect(bound[0]?.entry.path).toBe('delivery/at.md');
  });

  it('opaque source (not a flowchart) refuses, and says which refusal it is', () => {
    expect(insertRecordNode('gantt\n  title x', ENTRIES[0])).toEqual({
      ok: false,
      reason: 'opaque',
    });
  });

  it('a target no click line can carry refuses SEPARATELY — the canvas is fine', () => {
    // `setNodeLink` RETURNS A MODEL EVEN WHEN IT REFUSES — a blank target is
    // not a link, so it writes no line. Serializing that would leave an
    // unbound node named after a record: a half-insert nobody asked for. The
    // op reads its own result back and refuses the whole thing instead — and
    // as `unbindable`, not `opaque`, because the flowchart is perfectly fine
    // and only THIS record cannot go on it.
    const blank = makeEntry({ path: ' ', title: 'Nowhere' });
    expect(insertRecordNode('flowchart TD\n', blank)).toEqual({
      ok: false,
      reason: 'unbindable',
    });
  });

  it('a file whose NAME carries a double quote is unbindable, not silently mis-bound', () => {
    // `clickTarget` substitutes `"` (a quoted target has no escape for it), so
    // the emitted line names a path that does not exist. Legal filename on
    // macOS, so this arm is reachable rather than theoretical.
    const quoted = makeEntry({ path: 'delivery/say-"hi".md', title: 'Say hi' });
    expect(insertRecordNode('flowchart TD\n', quoted)).toEqual({
      ok: false,
      reason: 'unbindable',
    });
  });
});
