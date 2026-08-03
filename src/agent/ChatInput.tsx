import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '@/components/ui/Icon';
import { quickOpenScore } from '@/lib/quickOpenScore';
import { listSkills, type SkillRef } from '@/engine/skills';
import type { Entry } from '@/engine/types';
import { typeStyle } from '@/engine/typeCatalog';
import { useSchema, useVaultStore } from '@/stores/vaultStore';

/**
 * The composer, with `[[` completion (M9.5).
 *
 * A plain textarea makes you describe the note you mean and hope the agent
 * finds the same one. Naming it explicitly is both faster and unambiguous —
 * and the reference travels into the context snapshot with the note's
 * content attached, so the agent does not have to search for what you
 * already pointed at.
 */
export function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = 'Ask about this vault…',
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Take focus on mount — ⌘J opens a chat you can type into (M15). */
  autoFocus?: boolean;
}) {
  const entries = useVaultStore((s) => s.entries);
  const schema = useSchema();
  const ref = useRef<HTMLTextAreaElement>(null);
  const [active, setActive] = useState(0);
  // Escape dismisses the MENU, not the draft (M15). Keyed on what is being
  // completed so the next `[[` or `/` reopens it; the draft is never touched,
  // which is the whole point — Escape used to append `]]` at the END of the
  // message, wherever the caret happened to be.
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

  const matches = useMemo(() => {
    if (query === null) return [];
    return entries
      .filter((e) => e.type !== 'Type')
      .map((e) => ({ entry: e, score: quickOpenScore(query.fragment, e.title) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)
      .map((m) => m.entry);
  }, [query, entries]);

  const hasMatches = query !== null && matches.length > 0;

  // M13.1: `/` at the start of the message completes against the vault's
  // skills, the way `[[` completes against its notes. The menu lives only
  // while the WHOLE draft is the slash token — one space and it is prose.
  // Keyed on the value alone, no caret: a caret read during render is stale
  // for exactly the render a programmatic completion triggers, which left
  // the menu open on a draft it no longer matched.
  const skills = useMemo(() => listSkills(entries), [entries]);
  const slashFragment = useMemo(() => {
    const match = /^\/([a-z0-9-]*)$/i.exec(value);
    return match === null ? null : match[1].toLowerCase();
  }, [value]);
  const skillMatches = useMemo(() => {
    if (slashFragment === null) return [];
    return skills.filter((s) => s.name.startsWith(slashFragment)).slice(0, 6);
  }, [slashFragment, skills]);
  const hasSkillMatches = slashFragment !== null && skillMatches.length > 0;

  const completeSkill = (skill: SkillRef) => {
    // The whole draft IS the token while the menu is open, so completion
    // replaces it all. The trailing space turns it to prose — menu closed.
    onChange(`/${skill.name} `);
    setActive(0);
    requestAnimationFrame(() => ref.current?.focus());
  };

  // Both menus share one highlight index. Reset it whenever what is being
  // completed changes — a row arrowed to in one menu must not survive as a
  // phantom selection (or an out-of-range crash) in the other.
  const menuKey = slashFragment ?? query?.fragment ?? null;
  const lastMenuKey = useRef(menuKey);
  if (lastMenuKey.current !== menuKey) {
    lastMenuKey.current = menuKey;
    if (active !== 0) setActive(0);
  }

  // What an Escape dismisses: the slash token, or the specific `[[` being
  // completed. Keyed on the ANCHOR rather than the fragment so typing another
  // character does not resurrect a menu you just dismissed.
  const menuAnchor =
    slashFragment !== null ? 'slash' : query !== null ? `wiki:${query.start}` : null;
  if (dismissed !== null && menuAnchor === null) setDismissed(null);
  const open = hasMatches && dismissed !== menuAnchor;
  const slashOpen = hasSkillMatches && dismissed !== menuAnchor;

  const complete = (entry: Entry) => {
    if (query === null) return;
    const caret = ref.current?.selectionStart ?? value.length;
    const next = `${value.slice(0, query.start)}[[${entry.title}]]${value.slice(caret)}`;
    onChange(next);
    setActive(0);
    requestAnimationFrame(() => ref.current?.focus());
  };

  return (
    <div className="relative">
      {slashOpen && (
        <div
          data-testid="skill-menu"
          className="absolute bottom-full left-0 z-20 mb-1 w-full overflow-hidden rounded-lg border border-n-200 bg-n-0 shadow-[var(--shadow-lg)]"
        >
          {skillMatches.map((skill, i) => (
            <button
              key={skill.path}
              type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => completeSkill(skill)}
              className={[
                'flex w-full items-center gap-2 border-0 px-2.5 py-1.5 text-left text-xs',
                i === active ? 'bg-cortex-50' : 'bg-transparent hover:bg-n-25',
              ].join(' ')}
            >
              <Icon name="zap" size={12} color="var(--synapse-500)" />
              <span className="flex-none text-n-800">/{skill.name}</span>
              <span className="min-w-0 flex-1 truncate text-[10.5px] text-n-400">
                {skill.description}
              </span>
            </button>
          ))}
        </div>
      )}
      {open && (
        <div
          data-testid="wikilink-menu"
          className="absolute bottom-full left-0 z-20 mb-1 w-full overflow-hidden rounded-lg border border-n-200 bg-n-0 shadow-[var(--shadow-lg)]"
        >
          {matches.map((entry, i) => {
            const style = typeStyle(entry.type, schema);
            return (
              <button
                key={entry.path}
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => complete(entry)}
                className={[
                  'flex w-full items-center gap-2 border-0 px-2.5 py-1.5 text-left text-xs',
                  i === active ? 'bg-cortex-50' : 'bg-transparent hover:bg-n-25',
                ].join(' ')}
              >
                <Icon name={style.icon} size={12} color={style.color ?? 'var(--n-400)'} />
                <span className="min-w-0 flex-1 truncate text-n-800">{entry.title}</span>
                <span className="flex-none text-[10.5px] text-n-400">{entry.type ?? 'Note'}</span>
              </button>
            );
          })}
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
          // While the menu is open it owns the arrows and Enter — otherwise
          // picking a note would send the message instead.
          if (open) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, matches.length - 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              complete(matches[active] ?? matches[0]);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              // Dismiss the menu and nothing else. This used to append `]]`
              // to the END of the draft — committing a link you were
              // abandoning, at the wrong place if the caret was mid-message.
              setDismissed(menuAnchor);
              return;
            }
          }
          if (slashOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, skillMatches.length - 1));
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              completeSkill(skillMatches[active] ?? skillMatches[0]);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              // Dismissal is about the MENU: a draft that still reads
              // `/name` still invokes on send. To send it as literal text,
              // start the message with a space (see AiPanel.submit). What it
              // must not do is edit the draft — it used to append a space.
              setDismissed(menuAnchor);
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        className="w-full resize-none rounded-[9px] border border-n-200 bg-n-0 px-2.5 py-2 text-[12.5px] leading-[18px] text-n-900 outline-none placeholder:text-n-400 focus-visible:border-cortex-400"
      />
    </div>
  );
}
