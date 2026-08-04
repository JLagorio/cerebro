import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { quickOpenScore } from '@/lib/quickOpenScore';
import { argumentHint, listSkills, type SkillRef } from '@/engine/skills';
import { chipId, placeChip, recordChip, type ContextChip } from '@/agent/contextChips';
import type { Place } from '@/engine/place';
import type { Entry } from '@/engine/types';
import { typeStyle } from '@/engine/typeCatalog';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/**
 * The composer, with `[[`, `/` and `@` completion (M9.5, M13.1, M17.6b).
 *
 * Three tokens, three jobs, and the division is the point:
 *
 * - **`[[note]]`** MENTIONS a note inline. The text stays in the message and
 *   the note travels into the snapshot with its content attached, so the agent
 *   does not have to search for what you already pointed at.
 * - **`/skill`** INVOKES. The transcript shows what you typed; the agent gets
 *   the skill's body.
 * - **`@thing`** ATTACHES it as context and leaves no text behind. It is the
 *   explicit control M17.6's chips were missing — the way to hand the agent a
 *   record or a surface you are not currently standing on.
 *
 * All three used to be hand-rolled menus with their own copy of the arrow /
 * Enter / Tab / Escape handling. They are one driver now: a menu is a list of
 * items with a `run`, and the keyboard is written once. Adding `@` to the old
 * shape would have been a third copy of the same forty lines.
 */

/** One row of whichever menu is open. */
interface MenuItem {
  key: string;
  icon: string;
  color?: string;
  label: string;
  hint?: string;
  /** Section heading shown above this row when it differs from the row before. */
  group?: string;
  run: () => void;
}

interface Menu {
  testid: string;
  /** What an Escape dismisses. Keyed on the ANCHOR rather than the fragment so
   * typing another character does not resurrect a menu just dismissed. */
  anchor: string;
  items: MenuItem[];
}

export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = 'Ask about this vault…',
  autoFocus = false,
  onAttach,
  attached,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Take focus on mount — ⌘J opens a chat you can type into (M15). */
  autoFocus?: boolean;
  /** Attach a context chip (M17.6b). Absent disables `@` entirely: a menu
   * whose choices do nothing is worse than no menu. */
  onAttach?: (chip: ContextChip) => void;
  /** Chip ids already attached, so `@` does not offer them again. */
  attached?: readonly string[];
}) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const collections = useVaultStore((s) => s.collections);
  const schema = useSchema();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [active, setActive] = useState(0);
  // Escape dismisses the MENU, not the draft (M15). The draft is never
  // touched, which is the whole point — Escape used to append `]]` at the END
  // of the message, wherever the caret happened to be.
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  // The open `[[` immediately before the caret, if any. Anchored to the end
  // so a completed link earlier in the message does not reopen the menu.
  const query = useMemo(() => {
    const caret = ref.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const open = before.lastIndexOf('[[');
    if (open === -1) return null;
    const fragment = before.slice(open + 2);
    if (fragment.includes(']') || fragment.includes('\n')) return null;
    return { fragment, start: open };
  }, [value]);

  // M13.1: `/` at the start of the message completes against the vault's
  // skills. The menu lives only while the WHOLE draft is the slash token —
  // one space and it is prose. Keyed on the value alone, no caret: a caret
  // read during render is stale for exactly the render a programmatic
  // completion triggers, which left the menu open on a draft it no longer
  // matched.
  const skills = useMemo(() => listSkills(entries), [entries]);
  const slashFragment = useMemo(() => {
    const match = /^\/([a-z0-9-]*)$/i.exec(value);
    return match === null ? null : match[1].toLowerCase();
  }, [value]);

  // M17.6b: `@` anywhere, on a word boundary. Unlike `[[` this leaves no text
  // behind, so it does not need a closing token — the fragment ends at the
  // first space.
  const at = useMemo(() => {
    const caret = ref.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const open = before.lastIndexOf('@');
    if (open === -1) return null;
    // A word boundary, so an email address is not a context menu.
    if (open > 0 && !/[\s(]/.test(before[open - 1])) return null;
    const fragment = before.slice(open + 1);
    if (/[\s\n]/.test(fragment)) return null;
    return { fragment: fragment.toLowerCase(), start: open, end: caret };
  }, [value]);

  const complete = (entry: Entry) => {
    if (query === null) return;
    const caret = ref.current?.selectionStart ?? value.length;
    onChange(`${value.slice(0, query.start)}[[${entry.title}]]${value.slice(caret)}`);
    setActive(0);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const completeSkill = (skill: SkillRef) => {
    // The whole draft IS the token while the menu is open, so completion
    // replaces it all. The trailing space turns it to prose — menu closed.
    onChange(`/${skill.name} `);
    setActive(0);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const attach = (chip: ContextChip) => {
    if (at === null || onAttach === undefined) return;
    onAttach(chip);
    // The token is consumed, not completed: what `@` produces is a chip, and
    // leaving `@Roadmap` in the prose would say the same thing twice.
    onChange(`${value.slice(0, at.start)}${value.slice(at.end)}`);
    setActive(0);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const wikilinkMenu = useMemo((): Menu | null => {
    if (query === null) return null;
    const items = entries
      .filter((e) => e.type !== 'Type')
      .map((e) => ({ entry: e, score: quickOpenScore(query.fragment, e.title) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(({ entry }) => {
        const style = typeStyle(entry.type, schema);
        return {
          key: entry.path,
          icon: style.icon,
          color: style.color ?? 'var(--n-400)',
          label: entry.title,
          hint: entry.type ?? 'Note',
          run: () => complete(entry),
        };
      });
    return items.length === 0
      ? null
      : { testid: 'wikilink-menu', anchor: `wiki:${query.start}`, items };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, entries, schema, value]);

  const skillMenu = useMemo((): Menu | null => {
    if (slashFragment === null) return null;
    const items = skills
      .filter((s) => s.name.startsWith(slashFragment))
      .slice(0, 6)
      .map((skill) => {
        // M17.8: the declared inputs, in the row that offers the skill. A
        // skill that wants a project name should say so where you pick it,
        // not after the turn comes back asking.
        const args = argumentHint(skill);
        return {
          key: skill.path,
          icon: 'zap',
          color: 'var(--synapse-500)',
          label: `/${skill.name}${args === '' ? '' : ` ${args}`}`,
          hint: skill.description,
          run: () => completeSkill(skill),
        };
      });
    return items.length === 0 ? null : { testid: 'skill-menu', anchor: 'slash', items };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slashFragment, skills]);

  const attachMenu = useMemo((): Menu | null => {
    if (at === null || onAttach === undefined) return null;
    const taken = new Set(attached ?? []);
    const match = (label: string) => (at.fragment === '' ? 1 : quickOpenScore(at.fragment, label));

    // Surfaces first — the thing you are least able to name any other way. A
    // record can always be mentioned with `[[`; a List has no such token.
    const places: Place[] = [
      ...views.map((v) => ({ kind: 'list' as const, id: v.id, collection: v.collection })),
      ...collections.map((c) => ({ kind: 'collection' as const, folder: c.folder })),
      ...[...schema.types.keys()].map((name) => ({ kind: 'type' as const, name })),
    ];
    const lookup = { entries, views, collections };
    const placeItems = places
      .map((place) => placeChip(place, lookup))
      .map((chip) => ({ chip, score: match(chip.label) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map(({ chip }) => ({
        key: chipId(chip),
        icon: 'map-pin',
        color: 'var(--n-400)',
        label: chip.label,
        hint: 'Surface',
        group: 'Surfaces',
        run: () => attach(chip),
      }));

    const recordItems = entries
      .filter((e) => e.type !== 'Type')
      .map((e) => ({ entry: e, score: match(e.title) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map(({ entry }) => {
        const style = typeStyle(entry.type, schema);
        const chip = recordChip(entry.path, entries);
        return {
          key: `record:${entry.path}`,
          icon: style.icon,
          color: style.color ?? 'var(--n-400)',
          label: entry.title,
          hint: entry.type ?? 'Note',
          group: 'Records',
          run: () => {
            if (chip !== null) attach(chip);
          },
        };
      });

    const items = [...placeItems, ...recordItems].filter((i) => !taken.has(i.key));
    return items.length === 0 ? null : { testid: 'attach-menu', anchor: `at:${at.start}`, items };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, attached, collections, entries, onAttach, schema, views, value]);

  // One menu at a time. Order is deliberate: `/` only matches when the whole
  // draft is the token, `[[` needs its own brackets, and `@` is the fallback —
  // so a draft can never satisfy two of them in a way that matters.
  const candidate = skillMenu ?? wikilinkMenu ?? attachMenu;
  if (dismissed !== null && candidate === null) setDismissed(null);
  const menu = candidate !== null && dismissed !== candidate.anchor ? candidate : null;

  // The highlight index is shared, so reset it whenever what is being
  // completed changes — a row arrowed to in one menu must not survive as a
  // phantom selection (or an out-of-range crash) in the next.
  const menuKey = candidate === null ? null : `${candidate.anchor}:${candidate.items.length}`;
  const lastMenuKey = useRef(menuKey);
  if (lastMenuKey.current !== menuKey) {
    lastMenuKey.current = menuKey;
    if (active !== 0) setActive(0);
  }

  return (
    <div className="relative">
      {menu !== null && (
        <div
          data-testid={menu.testid}
          className="absolute bottom-full left-0 z-20 mb-1 max-h-[240px] w-full overflow-y-auto rounded-lg border border-n-200 bg-n-0 shadow-[var(--shadow-lg)]"
        >
          {menu.items.map((item, i) => (
            <div key={item.key}>
              {item.group !== undefined && item.group !== menu.items[i - 1]?.group && (
                <div className="px-2.5 pb-0.5 pt-1.5 text-2xs font-medium uppercase tracking-wide text-n-400">
                  {item.group}
                </div>
              )}
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={item.run}
                className={[
                  'flex w-full items-center gap-2 border-0 px-2.5 py-1.5 text-left text-xs',
                  i === active ? 'bg-cortex-50' : 'bg-transparent hover:bg-n-25',
                ].join(' ')}
              >
                <Icon name={item.icon} size={12} color={item.color} />
                <span className="min-w-0 flex-1 truncate text-n-800">{item.label}</span>
                {item.hint !== undefined && (
                  <span className="max-w-[45%] flex-none truncate text-2xs text-n-400">
                    {item.hint}
                  </span>
                )}
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        aria-label="Message the assistant"
        value={value}
        rows={2}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // While a menu is open it owns the arrows and Enter — otherwise
          // picking a row would send the message instead.
          if (menu !== null) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, menu.items.length - 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              (menu.items[active] ?? menu.items[0]).run();
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              // Dismiss the menu and NOTHING else. This used to append `]]` to
              // the end of the draft — committing a link you were abandoning,
              // at the wrong place if the caret was mid-message — or a space,
              // in the slash case. A draft that still reads `/name` still
              // invokes on send; to send it literally, start with a space
              // (see AiPanel.submit).
              setDismissed(menu.anchor);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className="w-full resize-none rounded-lg border border-n-200 bg-n-0 px-2.5 py-2 text-sm leading-[18px] text-n-900 outline-none placeholder:text-n-400 focus-visible:border-cortex-400"
      />
    </div>
  );
}
