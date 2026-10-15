import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { libraryIcon, libraryKind, libraryLabelPlural, type LibraryKind } from '@/engine/library';
import {
  skillDraft,
  skillPatch,
  templateDraft,
  templatePatch,
  type SkillDraft,
  type TemplateDraft,
} from '@/engine/libraryDraft';
import { stampActivation, SCHEDULE_STAMP_FAILED, RESUME_STAMP_FAILED } from '@/agent/activation';
import { recordIdentity } from '@/engine/identity';
import { parseScheduleSet, nextSetFire, scheduleText } from '@/engine/skills';
import { listTypes } from '@/engine/typeCatalog';
import type { Entry, Schema } from '@/engine/types';
import { readNoteSource, saveNote, setNoteTitle, updateFrontmatter } from '@/lib/ipc';
import { splitFrontmatter } from '@/engine/frontmatter';
import { isStaleContent } from '@/engine/staleContent';
import { useNavStore } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { FileNote } from './chrome';
import { LibraryIndex } from './LibraryIndex';
import { SkillEditor } from './SkillEditor';
import { TemplateEditor } from './TemplateEditor';
import { createLibraryItem, libraryItemPlace } from './libraryActions';

/**
 * The library (M18): the assistant's own workshop.
 *
 * The shelf for all three kinds, and the editor for two. A skill or template
 * opens here, with the open item riding on the SELECTION rather than in
 * component state, so "the risk sweep" is a place the back button returns to
 * and a wikilink can point at. An agent opens as its own page (M55.12): its
 * card, New and a stale library path all go there.
 *
 * ## Why editing is explicit here
 *
 * Everywhere else in this app writes as you type; a note saves 500 ms after
 * the last keystroke and the concept of an unsaved document does not exist.
 * Skills and templates are the exception on purpose. A half-typed
 * `allowed-tools:` narrows a turn to the wrong tools, and a half-typed
 * `schedule:` or `fill:` starts runs nobody meant — both read by machinery
 * that does not wait for you to finish. So the editor holds a draft and Save
 * is a decision — the same reason the rewrite popover assembles its result
 * before applying it. Agent grants follow the same rule a row at a time
 * (AgentProperties).
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
  // An agent is a page (M55.12). A library path naming one — a stale link, a
  // history entry from before — forwards there, replacing this slot so Back
  // never lands on a selection that only forwards.
  const forwardTo = entry !== undefined && libraryKind(entry) === 'agent' ? entry.path : null;
  useEffect(() => {
    if (forwardTo !== null) navigate({ kind: 'doc', path: forwardTo }, { replace: true });
  }, [forwardTo, navigate]);

  /** Pause or resume, from the card. One key, written straight through. */
  const setDuty = (path: string, on: boolean) => {
    if (vaultPath === null) return;
    void (async () => {
      try {
        const current = entries.find((candidate) => candidate.path === path);
        const stamped =
          !on ||
          current === undefined ||
          (await stampActivation(
            vaultPath,
            recordIdentity(current),
            current.properties.schedule,
            new Date(),
          ));
        await updateFrontmatter(vaultPath, path, { paused: on ? null : true });
        if (!stamped) toast(RESUME_STAMP_FAILED);
        await rescan();
      } catch {
        toast("Couldn't change that");
      }
    })();
  };

  const create = () => {
    void createLibraryItem(tab).then((path) => {
      if (path !== null) navigate(libraryItemPlace(tab, path));
    });
  };

  if (forwardTo !== null) return null;

  if (entry === undefined) {
    return (
      <LibraryIndex
        tab={tab}
        onTab={(next) => go({ tab: next })}
        query={query}
        onQuery={setQuery}
        entries={entries}
        onOpen={(path) => (tab === 'agent' ? navigate({ kind: 'doc', path }) : go({ tab, path }))}
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

type Draft = { kind: 'skill'; value: SkillDraft } | { kind: 'template'; value: TemplateDraft };

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
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (vaultPath === null || entry === undefined) return;
    let live = true;
    void (async () => {
      try {
        const source = await readNoteSource(vaultPath, path);
        if (!live) return;
        const body = splitFrontmatter(source.content).body.replace(/^\n+/, '');
        setName(entry.title);
        setDraft(
          kind === 'template'
            ? { kind, value: templateDraft(entry, body) }
            : { kind: 'skill', value: skillDraft(entry, body) },
        );
        setDirty(false);
        setBaseHash(source.hash);
        setStale(false);
        setFailed(false);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
    // Background scans preserve the draft and the version it was based on.
    // Only opening another file or explicitly loading the new version resets it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath, path, kind, reload]);

  const edit = useCallback((next: Draft) => {
    setDraft(next);
    setDirty(true);
  }, []);

  const save = (overwrite = false) => {
    if (vaultPath === null || draft === null || baseHash === null || saving) return;
    setSaving(true);
    void (async () => {
      try {
        // Compare the loaded version before writing any part of this draft.
        // Title and frontmatter still use their own locked writers afterward.
        const body = draft.kind === 'template' ? draft.value.body : draft.value.instructions;
        await saveNote(
          vaultPath,
          path,
          body.endsWith('\n') ? body : `${body}\n`,
          overwrite ? undefined : baseHash,
        );
        if (name.trim() !== '' && name.trim() !== entry?.title) {
          await setNoteTitle(vaultPath, path, name.trim());
        }
        const hash = await updateFrontmatter(
          vaultPath,
          path,
          draft.kind === 'skill' ? skillPatch(draft.value) : templatePatch(draft.value),
        );
        if (
          draft.kind === 'skill' &&
          entry !== undefined &&
          scheduleText(draft.value.schedule) !== scheduleText(entry.properties.schedule)
        ) {
          if (
            !(await stampActivation(
              vaultPath,
              recordIdentity(entry),
              draft.value.schedule,
              new Date(),
            ))
          )
            toast(SCHEDULE_STAMP_FAILED);
        }
        setBaseHash(hash ?? (await readNoteSource(vaultPath, path)).hash);
        await rescan();
        setDirty(false);
        setStale(false);
      } catch (err) {
        if (isStaleContent(err)) setStale(true);
        else toast(err instanceof Error ? err.message : "Couldn't save");
      } finally {
        setSaving(false);
      }
    })();
  };

  const loadNewVersion = () => {
    if (saving) return;
    setSaving(true);
    void rescan()
      .then(() => setReload((value) => value + 1))
      .catch(() => toast("Couldn't load the new version"))
      .finally(() => setSaving(false));
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
              duty.on ? 'border-success-500 text-success-700' : 'border-n-200 text-n-500'
            }`}
          >
            <Icon
              name={duty.on ? 'circle-play' : 'circle-pause'}
              size={12}
              color={duty.on ? 'var(--success-700)' : 'var(--n-500)'}
            />
            {duty.label}
          </span>
        )}
        <Button variant="primary" size="sm" disabled={!dirty || saving} onClick={() => save()}>
          {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </Button>
      </div>

      {stale && (
        <div
          data-testid="library-stale"
          role="status"
          className="flex flex-wrap items-center gap-3 border-b border-n-200 bg-n-50 px-6 py-3 text-sm text-n-700"
        >
          <p className="m-0 flex-1">
            “{entry.title}” changed on disk since you opened it, so nothing was saved.
          </p>
          <Button size="sm" disabled={saving} onClick={loadNewVersion}>
            Load the new version
          </Button>
          <Button size="sm" disabled={saving} onClick={() => save(true)}>
            Save mine anyway
          </Button>
        </div>
      )}

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
  if (draft.kind === 'skill' && draft.value.schedule.length > 0) {
    const schedules = parseScheduleSet(draft.value.schedule);
    if (schedules === null) return { on: false, label: 'Schedule not understood' };
    if (nextSetFire(schedules, new Date()) === null)
      return { on: false, label: 'Its one time has passed' };
    return paused ? { on: false, label: 'Paused' } : { on: true, label: 'Scheduled' };
  }
  if (kind === 'skill') return { on: false, label: 'On demand' };
  return null;
}
