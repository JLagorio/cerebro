import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  LIBRARY_FOLDER,
  libraryIcon,
  libraryKind,
  libraryLabel,
  libraryLabelPlural,
  type LibraryKind,
} from '@/engine/library';
import {
  agentActive,
  agentDraft,
  agentPatch,
  skillDraft,
  skillPatch,
  templateDraft,
  templatePatch,
  type AgentDraft,
  type SkillDraft,
  type TemplateDraft,
} from '@/engine/libraryDraft';
import { parseSchedule } from '@/engine/skills';
import { listTypes } from '@/engine/typeCatalog';
import type { Entry, Schema } from '@/engine/types';
import { createNote, readNote, saveNote, setNoteTitle, updateFrontmatter } from '@/lib/ipc';
import { splitFrontmatter } from '@/lib/mockParse';
import { slugify } from '@/lib/slug';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { AgentEditor } from './AgentEditor';
import { FileNote } from './chrome';
import { LibraryIndex } from './LibraryIndex';
import { SkillEditor } from './SkillEditor';
import { TemplateEditor } from './TemplateEditor';

/**
 * The library (M18): the assistant's own workshop.
 *
 * Two states — a browsable index and one editor — with the open item riding on
 * the SELECTION rather than in component state, so "the release scout" is a
 * place the back button returns to and a wikilink can point at.
 *
 * ## Why editing is explicit here, and only here
 *
 * Everywhere else in this app writes as you type; a note saves 500 ms after
 * the last keystroke and the concept of an unsaved document does not exist.
 * These three files are the exception on purpose. A half-typed `scope:` is a
 * boundary that is briefly wrong, a half-typed trigger fires on the wrong
 * thing, and both are read by a background runner that does not wait for you
 * to finish. So the editor holds a draft and Save is a decision — the same
 * reason the rewrite popover assembles its result before applying it.
 */
export function LibraryPage() {
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const schema = useSchema();
  const toast = useUiStore((s) => s.toast);
  const [query, setQuery] = useState('');

  const nav = selection.kind === 'library' ? selection : { tab: undefined, path: undefined };
  const openPath = nav.path;
  const entry = useMemo(
    () => (openPath === undefined ? undefined : entries.find((e) => e.path === openPath)),
    [entries, openPath],
  );
  // The tab follows the open item when there is one: a skill opened from a
  // wikilink should not land you on whichever shelf you last browsed.
  const tab: LibraryKind =
    entry !== undefined ? (libraryKind(entry) ?? 'skill') : (nav.tab ?? 'skill');

  const go = (next: { tab?: LibraryKind; path?: string }) => navigate({ kind: 'library', ...next });

  /** Pause or resume, from the card. One key, written straight through. */
  const setDuty = (path: string, on: boolean) => {
    if (vaultPath === null) return;
    void (async () => {
      try {
        await updateFrontmatter(vaultPath, path, { paused: on ? null : true });
        await rescan();
      } catch {
        toast("Couldn't change that");
      }
    })();
  };

  const create = () => {
    if (vaultPath === null) return;
    void (async () => {
      try {
        const title = `New ${libraryLabel(tab).toLowerCase()}`;
        const slug = slugify(title);
        const path = await createNote(
          vaultPath,
          LIBRARY_FOLDER[tab],
          slug,
          // Ships INERT: no schedule, no trigger, no fill prompt. Something that
          // starts running the moment it is created is something nobody had a
          // chance to read. A `slug:` from the start on the two that have an
          // identity, because this one is certainly about to be renamed.
          tab === 'template'
            ? { type: null }
            : { type: tab === 'skill' ? 'Skill' : 'Agent', slug, description: '' },
          NEW_BODY[tab](title),
        );
        await rescan();
        go({ tab, path });
      } catch {
        toast(`Couldn't create the ${tab}`);
      }
    })();
  };

  if (entry === undefined) {
    return (
      <LibraryIndex
        tab={tab}
        onTab={(next) => go({ tab: next })}
        query={query}
        onQuery={setQuery}
        entries={entries}
        onOpen={(path) => go({ tab, path })}
        onCreate={create}
        onDuty={setDuty}
      />
    );
  }

  return (
    <LibraryEditor
      key={entry.path}
      kind={tab}
      path={entry.path}
      entries={entries}
      schemaTypes={typeNames(entries, schema)}
      onBack={() => go({ tab })}
    />
  );
}

/** Type names for the template editor's picker, minus the metatype — a
 * template that stamps `type: Type` would be writing schema. */
function typeNames(entries: Entry[], schema: Schema): string[] {
  return listTypes(entries, schema)
    .filter((t) => t.name !== 'Type')
    .map((t) => t.name);
}

const NEW_BODY: Record<LibraryKind, (title: string) => string> = {
  skill: (title) =>
    `# ${title}\n\nWhat should the assistant do when this is invoked? Write it as numbered steps.\n`,
  agent: (title) =>
    `# ${title}\n\nStanding instructions for every run. Say what to read, what to produce, and what never to touch.\n`,
  template: (title) => `# {{title}}\n\n<!-- ${title} -->\n`,
};

type Draft =
  | { kind: 'skill'; value: SkillDraft }
  | { kind: 'agent'; value: AgentDraft }
  | { kind: 'template'; value: TemplateDraft };

function LibraryEditor({
  kind,
  path,
  entries,
  schemaTypes,
  onBack,
}: {
  kind: LibraryKind;
  path: string;
  entries: Entry[];
  schemaTypes: string[];
  onBack: () => void;
}) {
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const entry = entries.find((e) => e.path === path);

  const [name, setName] = useState(entry?.title ?? '');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (vaultPath === null || entry === undefined) return;
    let live = true;
    void (async () => {
      try {
        const raw = await readNote(vaultPath, path);
        if (!live) return;
        const body = splitFrontmatter(raw).body.replace(/^\n+/, '');
        setName(entry.title);
        setDraft(
          kind === 'skill'
            ? { kind, value: skillDraft(entry, body) }
            : kind === 'agent'
              ? { kind, value: agentDraft(entry, body) }
              : { kind, value: templateDraft(entry, body) },
        );
        setDirty(false);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
    // Loads ONCE per file. Re-running on `entry` would throw away everything
    // typed the moment a background rescan produced a new object — and a
    // rescan happens on every save, including this editor's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath, path, kind]);

  const edit = useCallback((next: Draft) => {
    setDraft(next);
    setDirty(true);
  }, []);

  const save = () => {
    if (vaultPath === null || draft === null || saving) return;
    setSaving(true);
    void (async () => {
      try {
        // Body first, then title, then frontmatter — three sequential
        // read-modify-writes of the same file, and the title rewrites an H1
        // that the body write just placed.
        const body = draft.kind === 'template' ? draft.value.body : draft.value.instructions;
        await saveNote(vaultPath, path, body.endsWith('\n') ? body : `${body}\n`);
        if (name.trim() !== '' && name.trim() !== entry?.title) {
          await setNoteTitle(vaultPath, path, name.trim());
        }
        await updateFrontmatter(
          vaultPath,
          path,
          draft.kind === 'skill'
            ? skillPatch(draft.value)
            : draft.kind === 'agent'
              ? agentPatch(draft.value)
              : templatePatch(draft.value),
        );
        await rescan();
        setDirty(false);
      } catch (err) {
        toast(err instanceof Error ? err.message : "Couldn't save");
      } finally {
        setSaving(false);
      }
    })();
  };

  if (failed || entry === undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8">
        <p className="m-0 text-sm text-n-500">That file could not be read.</p>
        <Button size="sm" onClick={onBack}>
          Back to the library
        </Button>
      </div>
    );
  }

  const duty = dutyOf(kind, draft, entry.properties.paused === true);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="library-editor">
      <div className="flex flex-none items-center gap-2 border-b border-n-200 px-6 py-3">
        <button
          type="button"
          onClick={onBack}
          data-testid="library-back"
          className="flex items-center gap-1.5 rounded-md border-0 bg-transparent px-1.5 py-1 text-xs text-n-500 hover:bg-n-50 hover:text-n-800"
        >
          <Icon name="chevron-left" size={14} />
          {libraryLabelPlural(kind)}
        </button>
        <Icon name={libraryIcon(kind)} size={14} color="var(--synapse-500)" />
        <input
          value={name}
          aria-label="Name"
          data-testid="library-name"
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-md font-semibold text-n-900 outline-none hover:border-n-200 focus-visible:border-cortex-400"
        />
        {duty !== null && (
          <span
            data-testid="library-duty"
            className={`inline-flex flex-none items-center gap-1.5 rounded-md border px-2 py-1 text-2xs ${
              duty.on ? 'border-ok-500 text-ok-700' : 'border-n-200 text-n-500'
            }`}
          >
            <Icon
              name={duty.on ? 'circle-play' : 'circle-pause'}
              size={12}
              color={duty.on ? 'var(--ok-700)' : 'var(--n-500)'}
            />
            {duty.label}
          </span>
        )}
        <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={save}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[820px] px-6 py-5">
          {draft === null ? (
            <p className="m-0 text-sm text-n-400">Loading…</p>
          ) : draft.kind === 'skill' ? (
            <SkillEditor
              draft={draft.value}
              title={name}
              onChange={(value) => edit({ kind: 'skill', value })}
            />
          ) : draft.kind === 'agent' ? (
            <AgentEditor
              draft={draft.value}
              title={name}
              folders={folderList(entries)}
              onChange={(value) => edit({ kind: 'agent', value })}
            />
          ) : (
            <TemplateEditor
              draft={draft.value}
              types={schemaTypes}
              onChange={(value) => edit({ kind: 'template', value })}
            />
          )}
          <div className="mt-6 border-t border-n-200 pt-4">
            <FileNote path={path} />
          </div>
        </div>
      </div>
    </div>
  );
}

/** The header's on-duty pill. Derived from the DRAFT, so it answers for what
 * you are about to save rather than for what is on disk. */
function dutyOf(
  kind: LibraryKind,
  draft: Draft | null,
  paused: boolean,
): { on: boolean; label: string } | null {
  if (draft === null) return null;
  if (draft.kind === 'agent') {
    if (!agentActive(draft.value)) return { on: false, label: 'Nothing fires it' };
    return paused ? { on: false, label: 'Paused' } : { on: true, label: 'On duty' };
  }
  if (draft.kind === 'skill' && draft.value.schedule.trim() !== '') {
    if (parseSchedule(draft.value.schedule) === null) return { on: false, label: 'Bad schedule' };
    return paused ? { on: false, label: 'Paused' } : { on: true, label: 'Scheduled' };
  }
  if (kind === 'skill') return { on: false, label: 'On demand' };
  return null;
}

/** Every folder that holds a note, for the scope and trigger pickers. */
function folderList(entries: { folder: string }[]): string[] {
  return [...new Set(entries.map((e) => e.folder).filter((f) => f !== ''))].sort();
}
