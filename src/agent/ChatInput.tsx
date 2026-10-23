import { formatWikilink, linkTargetOf } from '@/engine/wikilink';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from '@/components/ai/Attachment';
import {
  PromptInputBody,
  PromptInputHeader,
  PromptInputTextarea,
} from '@/components/ai/PromptInput';
import { FileThumb } from '@/components/FileThumb';
import { Icon } from '@/components/ui/Icon';
import { useGhostOnUnmount } from '@/components/ui/motion';
import { useEscapeLayer } from '@/components/ui/Popover';
import { canPickFiles, pickFiles } from '@/lib/ipc';
import { rankNames } from '@/lib/nameRank';
import { registerOsDropZone } from '@/lib/osDrop';
import { UNTYPED_LABEL } from '@/engine/destinations';
import { argumentHint, listSkills, type SkillRef } from '@/engine/skills';
import { isAgentEntry, listAgents } from '@/engine/agents';
import { pastedFiles, type FileSource } from '@/agent/attachments';
import { chipId, placeChip, recordChip, type ContextChip } from '@/agent/contextChips';
import type { ComposerFile } from '@/agent/elements/attachments';
import type { Place } from '@/engine/place';
import type { Entry } from '@/engine/types';
import { typeStyle } from '@/engine/typeCatalog';
import { useRecency } from '@/stores/openLogStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import './chat-input.css';

/**
 * The composer's text, with `[[`, `/` and `@` completion (M9.5, M13.1,
 * M17.6b, M33b.6). It is the body of a Prompt Input (M91.12a), so it sits
 * inside one: the PromptInput's Enter sends and Shift+Enter breaks the line,
 * an Enter that ends an IME composition never sends, and nothing here is a
 * form.
 *
 * Three tokens, and the division is the point:
 *
 * - **`[[note]]`** MENTIONS a note inline. The text stays in the message and
 *   the note travels into the snapshot with its content attached, so the agent
 *   does not have to search for what you already pointed at.
 * - **`/skill`** INVOKES. The transcript shows what you typed; the agent gets
 *   the skill's body.
 * - **`@`** does two things, and they are the same shape: it names a
 *   RECIPIENT or attaches CONTEXT. `@agent-slug` addresses one of the vault's
 *   agents and stays in the message as text, because the send path reads the
 *   recipient back out of what you wrote (M33b.6). Everything else — a
 *   record, a surface — becomes a chip and leaves no text behind, which is
 *   the explicit control M17.6's chips were missing.
 *
 * All three used to be hand-rolled menus with their own copy of the arrow /
 * Enter / Tab / Escape handling. They are one driver now: a menu is a list of
 * items with a `run`, and the keyboard is written once. Adding `@` to the old
 * shape would have been a third copy of the same forty lines.
 *
 * Files from outside the vault come in three ways (M91.17): `@`'s Attach a
 * file row, which opens the native picker or the browser's; a drop on the
 * composer, through the one OS drop router; and a paste that carries a file
 * rather than text. Each hands them to the panel, which copies them in when
 * the message is sent. They are drawn as Attachments above the text.
 */

/** The Attach a file row's words, and the words it answers to in `@`. */
const ATTACH_FILE = {
  label: 'Attach a file…',
  hint: 'From your computer',
  names: ['Attach a file', 'Upload a file'],
} as const;

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

/**
 * The open menu, on the layer stack (M52).
 *
 * The textarea took its own Escape, in React's bubble phase — after every
 * layer's capture-phase listener on window had already had it. So with a
 * page's side panel open as a drawer, Escape in the `[[` menu closed the
 * drawer and left the menu open, and beside a record it closed the record.
 * A menu on the stack is the innermost surface, and Escape closes it first.
 */
function MenuLayer({
  onEscape,
  menuRef,
}: {
  onEscape: () => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
}) {
  useEscapeLayer(onEscape, { contains: (node) => menuRef.current?.contains(node) === true });
  return null;
}

/**
 * The open menu's surface, above the input it completes. It grows up out of
 * the input as a popover opened above its anchor does (index.css), and
 * closed — a row taken, Escape, a space — a copy of it fades where it was
 * (components/ui/motion.ts) while the real one has already gone.
 */
function CompletionMenu({
  menuRef,
  testid,
  children,
}: {
  menuRef: React.RefObject<HTMLDivElement | null>;
  testid: string;
  children: React.ReactNode;
}) {
  useGhostOnUnmount(menuRef, 'cb-popover-leave', { strip: ['cb-menu-in'] });
  return (
    <div
      ref={menuRef}
      data-testid={testid}
      className="cb-chat-complete cb-menu-in absolute bottom-full left-0 z-20 mb-1 max-h-[240px] w-full overflow-y-auto rounded-lg border border-n-200 bg-n-0 shadow-[var(--shadow-lg)]"
    >
      {children}
    </div>
  );
}

export function ChatInput({
  value,
  onChange,
  placeholder = 'Ask about this vault…',
  autoFocus = false,
  onAttach,
  attached,
  inputRef,
  suspended = false,
  files = [],
  onAttachFiles,
  onRemoveFile,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Mounted but out of sight (the assistant folded onto its button): no
   *  completion menu opens, so none holds Escape on the layer stack. What
   *  was dismissed stays dismissed for when it is shown again. */
  suspended?: boolean;
  placeholder?: string;
  /** Take focus on mount — ⌘J opens a chat you can type into (M15). */
  autoFocus?: boolean;
  /** Attach a context chip (M17.6b). Absent disables `@` entirely: a menu
   * whose choices do nothing is worse than no menu. */
  onAttach?: (chip: ContextChip) => void;
  /** Chip ids already attached, so `@` does not offer them again. */
  attached?: readonly string[];
  inputRef?: RefObject<HTMLTextAreaElement | null>;
  /** The files on the message (M91.17), drawn as Attachments above the text. */
  files?: readonly ComposerFile[];
  /** Hand over files from outside the vault (M91.17). Absent, nothing offers
   * to take one: no Attach a file row, no drop zone, and a paste is text. */
  onAttachFiles?: (sources: readonly FileSource[]) => void;
  /** Take a file off the message, by its chip's id. */
  onRemoveFile?: (id: string) => void;
}) {
  const entries = useVaultStore((s) => s.entries);
  const views = useVaultStore((s) => s.views);
  const collections = useVaultStore((s) => s.collections);
  const schema = useSchema();
  const recency = useRecency();
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const ref = inputRef ?? ownRef;
  const menuRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  // Escape dismisses the MENU, not the draft (M15). The draft is never
  // touched, which is the whole point — Escape used to append `]]` at the END
  // of the message, wherever the caret happened to be.
  const [dismissed, setDismissed] = useState<string | null>(null);
  // An IME composition is open: its keys are its own (§3.3).
  const composing = useRef(false);
  // The browser's picker, for a build with no native one.
  const fileInput = useRef<HTMLInputElement>(null);
  const takeFiles = useRef(onAttachFiles);
  takeFiles.current = onAttachFiles;
  const [dropOver, setDropOver] = useState(false);
  const takesFiles = onAttachFiles !== undefined;

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus, ref]);

  // A drop on the composer, anywhere on its pill: the OS router's zone
  // (lib/osDrop.ts), which Tauri's native drags and the mock's both reach.
  useEffect(() => {
    const pill = ref.current?.closest<HTMLElement>('[data-slot="prompt-input"]');
    if (!takesFiles || pill === null || pill === undefined) return;
    const release = registerOsDropZone(pill, {
      over: setDropOver,
      drop: (paths) => takeFiles.current?.(paths),
    });
    return () => {
      release();
      setDropOver(false);
    };
  }, [takesFiles, ref]);

  // The open `[[` immediately before the caret, if any. Anchored to the end
  // so a completed link earlier in the message does not reopen the menu.
  // A programmatic append can render before React updates the focused DOM
  // value. Its old caret is not a position in the new draft. Native typing
  // already changed the DOM value, so it keeps its real in-text caret.
  const caret =
    ref.current !== null && ref.current === document.activeElement && ref.current.value === value
      ? ref.current.selectionStart
      : value.length;
  const query = useMemo(() => {
    const before = value.slice(0, caret);
    const open = before.lastIndexOf('[[');
    if (open === -1) return null;
    const fragment = before.slice(open + 2);
    if (fragment.includes(']') || fragment.includes('\n')) return null;
    return { fragment, start: open };
  }, [value, caret]);

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
    const before = value.slice(0, caret);
    const open = before.lastIndexOf('@');
    if (open === -1) return null;
    // A word boundary, so an email address is not a context menu.
    if (open > 0 && !/[\s(]/.test(before[open - 1])) return null;
    const fragment = before.slice(open + 1);
    if (/[\s\n]/.test(fragment)) return null;
    return { fragment: fragment.toLowerCase(), start: open, end: caret };
  }, [value, caret]);

  const complete = (entry: Entry) => {
    if (query === null) return;
    const caret = ref.current?.selectionStart ?? value.length;
    onChange(
      `${value.slice(0, query.start)}${formatWikilink(linkTargetOf(entry))}${value.slice(caret)}`,
    );
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
    // The token is consumed, not completed: what this row produces is a chip,
    // and leaving `@Roadmap` in the prose would say the same thing twice.
    // (An agent row is the exception — see addressAgent.)
    onChange(`${value.slice(0, at.start)}${value.slice(at.end)}`);
    setActive(0);
    requestAnimationFrame(() => ref.current?.focus());
  };

  /**
   * Attach a file from outside the vault (M91.17): the token is consumed, as
   * a chip row's is, and the picker opens — the native one where there is
   * one, the browser's otherwise. Picking nothing changes nothing.
   */
  const attachFromComputer = () => {
    if (at === null || onAttachFiles === undefined) return;
    onChange(`${value.slice(0, at.start)}${value.slice(at.end)}`);
    setActive(0);
    if (canPickFiles()) {
      void pickFiles().then(
        (paths) => {
          if (paths.length > 0) takeFiles.current?.(paths);
        },
        (error: unknown) =>
          useUiStore
            .getState()
            .toast(
              `Couldn't choose files — ${error instanceof Error ? error.message : String(error)}`,
            ),
      );
    } else {
      fileInput.current?.click();
    }
    requestAnimationFrame(() => ref.current?.focus());
  };

  /**
   * Address an agent (M33b.6) — the one row in this menu that COMPLETES rather
   * than consumes.
   *
   * A recipient is not context. It is who the turn goes to, and `send` reads it
   * back out of the message text, so the handle has to survive as text — which
   * also means the transcript shows what you addressed instead of hiding it in
   * a chip you have to remember attaching.
   */
  const addressAgent = (handle: string) => {
    if (at === null) return;
    const after = value.slice(at.end);
    onChange(`${value.slice(0, at.start)}@${handle}${after.startsWith(' ') ? '' : ' '}${after}`);
    // Closed by the same anchor an Escape uses, and it has to be explicit:
    // every other row in this menu ends by REMOVING the `@` token, so the menu
    // stops matching on its own. A completed handle is still an `@` token, and
    // the caret read this memo depends on lags a programmatic edit by a render
    // — the stale-caret trap the slash menu avoids by keying on the value
    // alone. A menu left open here would swallow the next Enter forever.
    setDismissed(`at:${at.start}`);
    setActive(0);
    requestAnimationFrame(() => ref.current?.focus());
  };

  // Every menu here ranks through the one name ranker (M59.3): the match
  // tier first, then your own recent opens within it.
  const wikilinkMenu = useMemo((): Menu | null => {
    // A bare `[[` offers nothing until something is typed, as before.
    if (query === null || query.fragment.trim() === '') return null;
    const items = rankNames({
      query: query.fragment,
      items: entries.filter((e) => e.type !== 'Type'),
      texts: (e) => [e.title],
      path: (e) => e.path,
      recency,
      limit: 6,
    }).items.map((entry) => {
      const style = typeStyle(entry.type, schema);
      return {
        key: entry.path,
        icon: style.icon,
        color: style.color ?? 'var(--n-400)',
        label: entry.title,
        hint: entry.type ?? UNTYPED_LABEL,
        run: () => complete(entry),
      };
    });
    return items.length === 0
      ? null
      : { testid: 'wikilink-menu', anchor: `wiki:${query.start}`, items };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, entries, schema, value, recency]);

  const skillMenu = useMemo((): Menu | null => {
    if (slashFragment === null) return null;
    // A prefix still ranks first; a word inside a name (`sweep` in
    // `risk-sweep`) now matches below it.
    const items = rankNames({
      query: slashFragment,
      items: skills,
      texts: (s) => [s.name],
      path: (s) => s.path,
      recency,
      limit: 6,
    }).items.map((skill) => {
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
  }, [slashFragment, skills, recency]);

  const attachMenu = useMemo((): Menu | null => {
    if (at === null) return null;
    const taken = new Set(attached ?? []);
    const rank = <T,>(
      items: readonly T[],
      texts: (item: T) => string[],
      limit: number,
      path?: (item: T) => string,
    ) => rankNames({ query: at.fragment, items, texts, path, recency, limit }).items;

    // Surfaces first — the thing you are least able to name any other way. A
    // record can always be mentioned with `[[`; a List has no such token.
    const places: Place[] = [
      ...views.map((v) => ({ kind: 'list' as const, id: v.id, collection: v.collection })),
      ...collections.map((c) => ({ kind: 'collection' as const, folder: c.folder })),
      ...[...schema.types.keys()].map((name) => ({ kind: 'type' as const, name })),
    ];
    const lookup = { entries, views, collections };
    const placeItems = rank(
      places.map((place) => placeChip(place, lookup)),
      (chip) => [chip.label],
      4,
    ).map((chip) => ({
      key: chipId(chip),
      icon: 'map-pin',
      color: 'var(--n-400)',
      label: chip.label,
      hint: 'Surface',
      group: 'Surfaces',
      run: () => attach(chip),
    }));

    // Agent records are deliberately absent from here: they get their own rows
    // below, which ADDRESS them. Offering one record two ways — "attach this
    // page" and "talk to this agent" — reads as a duplicate long before it
    // reads as a choice, and addressing already carries everything attaching
    // would have (its brief, its memory, its scope).
    const recordItems = rank(
      entries.filter((e) => e.type !== 'Type' && !isAgentEntry(e)),
      (e) => [e.title],
      6,
      (e) => e.path,
    ).map((entry) => {
      const style = typeStyle(entry.type, schema);
      const chip = recordChip(entry.path, entries);
      return {
        key: `record:${entry.path}`,
        icon: style.icon,
        color: style.color ?? 'var(--n-400)',
        label: entry.title,
        hint: entry.type ?? UNTYPED_LABEL,
        group: 'Records',
        run: () => {
          if (chip !== null) attach(chip);
        },
      };
    });

    // M33b.6 — the agents this vault holds, addressable by the handle their
    // writes are already stamped with. LAST, and not for lack of importance:
    // every row above consumes the token and produces a chip, and these do the
    // opposite, so they are grouped apart from the rows that behave alike
    // rather than interleaved with them.
    const agentItems = rank(
      listAgents(entries).filter((agent) => agent.handle !== ''),
      (agent) => [agent.handle, agent.title],
      4,
      (agent) => agent.path,
    ).map((agent) => ({
      key: `agent:${agent.handle}`,
      icon: 'bot',
      color: 'var(--synapse-500)',
      label: `@${agent.handle}`,
      hint: agent.title,
      group: 'Agents',
      run: () => addressAgent(agent.handle),
    }));

    // M91.17 — a file from outside the vault, last: a record already in the
    // vault is one of the rows above. Ranked by its own words like any row,
    // so an `@` that names nothing else closes the menu, and Enter sends.
    const fileItems = !takesFiles
      ? []
      : rank([ATTACH_FILE], (row) => [...row.names], 1).map((row) => ({
          key: 'attach-file',
          icon: 'paperclip',
          color: 'var(--n-400)',
          label: row.label,
          hint: row.hint,
          group: 'Files',
          run: attachFromComputer,
        }));

    const chipItems = onAttach === undefined ? [] : [...placeItems, ...recordItems];
    const items = [...chipItems, ...agentItems, ...fileItems].filter((i) => !taken.has(i.key));
    return items.length === 0 ? null : { testid: 'attach-menu', anchor: `at:${at.start}`, items };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, attached, collections, entries, onAttach, schema, views, value, recency, takesFiles]);

  // One menu at a time. Order is deliberate: `/` only matches when the whole
  // draft is the token, `[[` needs its own brackets, and `@` is the fallback —
  // so a draft can never satisfy two of them in a way that matters.
  const candidate = skillMenu ?? wikilinkMenu ?? attachMenu;
  if (dismissed !== null && candidate === null) setDismissed(null);
  const menu =
    !suspended && candidate !== null && dismissed !== candidate.anchor ? candidate : null;

  // The highlight index is shared, so reset it whenever what is being
  // completed changes — a row arrowed to in one menu must not survive as a
  // phantom selection (or an out-of-range crash) in the next.
  const menuKey = candidate === null ? null : `${candidate.anchor}:${candidate.items.length}`;
  const lastMenuKey = useRef(menuKey);
  if (lastMenuKey.current !== menuKey) {
    lastMenuKey.current = menuKey;
    if (active !== 0) setActive(0);
  }

  const menuOpen = menu !== null;
  useLayoutEffect(() => {
    const anchor = ref.current?.parentElement;
    const surface = menuRef.current;
    const boundary = anchor?.closest('.cb-chat-body');
    if (!menuOpen || !anchor || !surface || !boundary) return;
    // The empty conversation centers this input. Its completion menu must
    // fit above that new position rather than disappear behind the header.
    const fit = () => {
      const frame = boundary.getBoundingClientRect();
      if (frame.height === 0) return;
      const available = anchor.getBoundingClientRect().top - frame.top - 8;
      surface.style.maxHeight = `${Math.max(0, Math.min(240, available))}px`;
    };
    fit();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(anchor);
    observer?.observe(boundary);
    const composer = anchor.closest('.cb-chat-composer');
    if (composer) observer?.observe(composer);
    boundary.addEventListener('scroll', fit, { passive: true });
    window.addEventListener('resize', fit);
    return () => {
      observer?.disconnect();
      boundary.removeEventListener('scroll', fit);
      window.removeEventListener('resize', fit);
    };
  }, [menuOpen, ref]);

  return (
    <>
      {/* M91.17: the message's files, across the pill above its text (the
          header's place in a Prompt Input, chat-input.css). */}
      {files.length > 0 && (
        <PromptInputHeader className="cb-chat-attachments">
          <Attachments aria-label="Attached files" data-testid="composer-attachments">
            {files.map((file) => (
              <Attachment
                key={file.data.id}
                data={file.data}
                state={file.state}
                size="sm"
                data-testid="composer-attachment"
                data-path={file.data.path}
                onRemove={onRemoveFile === undefined ? undefined : () => onRemoveFile(file.data.id)}
              >
                <AttachmentPreview
                  // The element draws no picture itself (CV-64); FileThumb is
                  // the derived-image boundary (CV-61).
                  thumbnail={({ rootId, path }, icon) => (
                    <FileThumb
                      rootId={rootId}
                      path={path}
                      size={64}
                      fit="cover"
                      compact
                      alt={file.data.label}
                      className="cb-ai-attachment-thumb"
                      fallback={() => icon}
                    />
                  )}
                />
                <AttachmentInfo />
                <AttachmentRemove
                  label={`Remove ${file.data.label} from context`}
                  disabled={file.state === 'uploading'}
                />
              </Attachment>
            ))}
          </Attachments>
        </PromptInputHeader>
      )}
      {dropOver && (
        <div className="cb-chat-drop" aria-hidden="true">
          <Icon name="paperclip" size={14} />
          Drop to attach
        </div>
      )}
      {/* The body is the menu's anchor: it grows up out of the text's own box. */}
      <PromptInputBody className="relative">
        {menu !== null && (
          <MenuLayer
            // Dismiss the menu and NOTHING else. This used to append `]]` to the
            // end of the draft — committing a link you were abandoning, at the
            // wrong place if the caret was mid-message — or a space, in the
            // slash case. A draft that still reads `/name` still invokes on
            // send; to send it literally, start with a space (see
            // AiPanel.submit).
            onEscape={() => setDismissed(menu.anchor)}
            menuRef={menuRef}
          />
        )}
        {menu !== null && (
          <CompletionMenu menuRef={menuRef} testid={menu.testid}>
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
                    'motion-hover flex w-full items-center gap-2 border-0 px-2.5 py-1.5 text-left text-xs',
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
          </CompletionMenu>
        )}
        {takesFiles && (
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            aria-hidden="true"
            data-testid="composer-file-input"
            onChange={(e) => {
              const chosen = [...(e.currentTarget.files ?? [])];
              // Cleared, so choosing the same file again fires change again.
              e.currentTarget.value = '';
              if (chosen.length > 0) takeFiles.current?.(chosen);
            }}
          />
        )}
        <PromptInputTextarea
          ref={ref}
          aria-label="Message the assistant"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          onPaste={(e) => {
            if (onAttachFiles === undefined) return;
            const pasted = pastedFiles(e.clipboardData);
            if (pasted.length === 0) return;
            e.preventDefault();
            onAttachFiles(pasted);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(e) => {
            // A composition's Enter commits its word and its arrows walk its
            // candidates, the 229 WebKit sends after compositionend included:
            // no row is picked, and the PromptInput sends nothing.
            if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
            // While a menu is open it owns the arrows and Enter — otherwise
            // picking a row would send the message instead. A prevented Enter
            // is not the PromptInput's to send.
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
              // Escape is MenuLayer's: it reaches the stack before it reaches
              // this textarea.
            }
          }}
        />
      </PromptInputBody>
    </>
  );
}
