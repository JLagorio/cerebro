import {
  documentAdmission,
  holdDocumentReader,
  subscribeDocumentAdmission,
} from '@/editor/documentAdmission';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { libraryIcon, libraryKind, libraryLabelPlural, type LibraryKind } from '@/engine/library';
import {
  type LibraryDraftOwner,
  libraryDraftKey,
  loadLibraryDraftOwner,
  retainedLibraryDraft,
  type LibraryDraft as Draft,
} from './libraryDraftOwner';
import { registerSaveParticipant } from '@/editor/openPages';
import { stampActivation, RESUME_STAMP_FAILED } from '@/agent/activation';
import { recordIdentity } from '@/engine/identity';
import { parseScheduleSet, nextSetFire } from '@/engine/skills';
import { listTypes } from '@/engine/typeCatalog';
import type { Entry, Schema, LibraryTab } from '@/engine/types';
import { updateFrontmatter, writeClipboard } from '@/lib/ipc';
import { useNavStore, usePaneId } from '@/stores/navStore';
import { useUiStore } from '@/stores/uiStore';
import { useSchema, useVaultStore } from '@/stores/vaultStore';
import { FileNote } from './chrome';
import { LibraryIndex } from './LibraryIndex';
import { WorkflowLibrary } from './WorkflowLibrary';
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
  const pane = usePaneId();
  const selection = useNavStore((s) => s.selection);
  const navigate = useNavStore((s) => s.navigate);
  const entries = useVaultStore((s) => s.entries);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const schema = useSchema();
  const toast = useUiStore((s) => s.toast);
  const [query, setQuery] = useState('');

  const nav =
    selection.kind === 'library'
      ? selection
      : { tab: undefined, path: undefined, workflowId: undefined };
  const openPath = nav.path;
  const entry = useMemo(
    () => (openPath === undefined ? undefined : entries.find((e) => e.path === openPath)),
    [entries, openPath],
  );
  // The tab follows the open item when there is one: a skill opened from a
  // wikilink should not land you on whichever shelf you last browsed.
  const tab: LibraryKind =
    entry !== undefined
      ? (libraryKind(entry) ?? 'skill')
      : nav.tab === 'workflow'
        ? 'skill'
        : (nav.tab ?? 'skill');

  const go = (next: { tab?: LibraryTab; path?: string; workflowId?: string }) =>
    navigate({ kind: 'library', ...next });
  const tabStrip = useRef<HTMLDivElement>(null);
  const pendingTabFocus = useRef<{
    tab: LibraryTab;
    source: Element | null;
    vault: string | null;
  } | null>(null);
  const changeTab = (next: LibraryTab) => {
    const source = document.activeElement;
    pendingTabFocus.current = tabStrip.current?.querySelector('[role="tablist"]')?.contains(source)
      ? { tab: next, source, vault: vaultPath }
      : null;
    go({ tab: next });
  };
  useLayoutEffect(() => {
    const pending = pendingTabFocus.current;
    pendingTabFocus.current = null;
    if (pending === null || pending.tab !== nav.tab || pending.vault !== vaultPath) return;
    const active = document.activeElement;
    // The tab's previous owner may have unmounted. Transfer only its focus;
    // navigation from elsewhere must not steal a newer control's focus.
    if (
      active !== document.body &&
      active !== pending.source &&
      !tabStrip.current?.querySelector('[role="tablist"]')?.contains(active)
    )
      return;
    tabStrip.current
      ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
      ?.focus({ preventScroll: true });
  }, [nav.tab, vaultPath]);
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

  if (nav.tab === 'workflow')
    return (
      <WorkflowLibrary
        key={vaultPath ?? 'no-vault'}
        vaultKey={vaultPath}
        workflowId={nav.workflowId}
        onTab={changeTab}
        tabStripRef={tabStrip}
        onSelect={(workflowId) => go({ tab: 'workflow', workflowId })}
      />
    );

  if (forwardTo !== null) return null;

  if (
    entry === undefined &&
    !(vaultPath && openPath && retainedLibraryDraft(vaultPath, openPath, pane))
  ) {
    return (
      <LibraryIndex
        tab={tab}
        onTab={changeTab}
        tabStripRef={tabStrip}
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
      key={`${vaultPath}:${pane}:${openPath}`}
      kind={tab}
      path={openPath!}
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
  const pane = usePaneId();
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  const entry = entries.find((e) => e.path === path);

  const [owner, setOwner] = useState<LibraryDraftOwner | null>(() =>
    vaultPath === null ? null : (retainedLibraryDraft(vaultPath, path, pane) ?? null),
  );
  const admission = useSyncExternalStore(subscribeDocumentAdmission, () =>
    vaultPath === null
      ? null
      : documentAdmission(libraryDraftKey(vaultPath, path, pane), owner ?? undefined),
  );
  useLayoutEffect(
    () =>
      vaultPath === null ? undefined : holdDocumentReader(libraryDraftKey(vaultPath, path, pane)),
    [vaultPath, path, pane],
  );
  const [, redraw] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  useEffect(() => {
    if (owner !== null || vaultPath === null || entry === undefined) return;
    let live = true;
    let retired = false;
    const stop = useVaultStore.subscribe((next, previous) => {
      if (next.vaultPath !== previous.vaultPath) retired = true;
    });
    setFailed(null);
    void loadLibraryDraftOwner(
      libraryDraftKey(vaultPath, path, pane),
      kind === 'template' ? kind : 'skill',
      () => live && !retired,
    )
      .then((loaded) => {
        if (live && !retired && loaded !== null) setOwner(loaded);
      })
      .catch((error) => {
        if (live && !retired)
          setFailed(error instanceof Error ? error.message : 'That file could not be read.');
      });
    return () => {
      live = false;
      stop();
    };
    // A scan must not replace this editor's retained base or form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultPath, path, kind, owner, pane, loadAttempt]);
  // The editable form must enter the save registry before input can arrive.
  useLayoutEffect(() => {
    if (owner === null) return;
    const unsubscribe = owner.subscribe(() => {
      setCopied(false);
      setCopyFailed(false);
      redraw((value) => value + 1);
    });
    const detach = registerSaveParticipant(owner);
    return () => {
      unsubscribe();
      detach();
    };
  }, [owner]);
  const name = owner?.name ?? entry?.title ?? '';
  const draft = owner?.draft ?? null;
  const dirty = owner?.dirty ?? false;
  const saving = (owner?.saving ?? false) || loading;
  const stale = owner?.stale ?? false;
  const edit = (next: Draft) => owner?.edit(name, next);
  const save = (overwrite = false) => {
    void owner?.save(overwrite);
  };
  const loadNewVersion = () => {
    if (saving || vaultPath === null || owner === null) return;
    setLoading(true);
    const decisionGeneration = owner.snapshot().generation;
    let retired = false;
    const stop = useVaultStore.subscribe((next, previous) => {
      if (next.vaultPath !== previous.vaultPath) retired = true;
    });
    void (async () => {
      try {
        await rescan();
        if (retired) return;
        const replacement = await loadLibraryDraftOwner(
          libraryDraftKey(vaultPath, path, pane),
          draft?.kind ?? 'skill',
          () => !retired,
        );
        if (retired || replacement === null) return;
        if (owner.snapshot().generation !== decisionGeneration) {
          toast('New edits were made while loading. Your draft is retained.');
          return;
        }
        owner.discard();
        setOwner(replacement);
      } catch {
        if (!retired) toast("Couldn't load the new version. Your draft is retained.");
      } finally {
        stop();
        setLoading(false);
      }
    })();
  };

  if (admission?.kind === 'deferred')
    return <div role="status">Page is moving. Wait for it to finish.</div>;
  if (owner === null && (failed !== null || entry === undefined)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8">
        <p role="status" className="m-0 text-sm text-n-500">
          {failed ?? 'That file could not be read.'}
        </p>
        <Button size="sm" onClick={() => setLoadAttempt((value) => value + 1)}>
          Retry load
        </Button>
        <Button size="sm" onClick={onBack}>
          Back to the library
        </Button>
      </div>
    );
  }

  const duty = dutyOf(kind, draft, (entry ?? owner?.entry)?.properties.paused === true);

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
          disabled={owner === null}
          aria-label="Name"
          data-testid="library-name"
          onChange={(e) => {
            if (owner) owner.edit(e.target.value, owner.draft);
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

      {owner !== null && (dirty || owner.message !== null || owner.refreshFailed) && (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 border-b border-n-200 bg-n-50 px-6 py-3 text-sm text-n-700"
        >
          <p className="m-0 flex-1">
            {entry === undefined
              ? 'The file is missing. Your draft is retained; copy it or discard it.'
              : (owner.message ??
                (owner.refreshFailed
                  ? 'Saved, but the library could not be refreshed.'
                  : 'Unsaved draft. Save explicitly to apply these instructions and settings.'))}
          </p>
          {owner.message !== null && !stale && entry !== undefined && (
            <Button size="sm" disabled={saving} onClick={() => save()}>
              Retry save
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => {
              setCopyFailed(false);
              void writeClipboard(owner.snapshot().latestDraft)
                .then(() => setCopied(true))
                .catch(() => setCopyFailed(true));
            }}
          >
            {copied ? 'Copied draft' : 'Copy draft'}
          </Button>
          {copyFailed && <span>Couldn't copy. Your draft is retained.</span>}
          <Button size="sm" disabled={saving} onClick={() => owner.discard()}>
            Discard draft
          </Button>
        </div>
      )}
      {stale && (
        <div
          data-testid="library-stale"
          role="status"
          className="flex flex-wrap items-center gap-3 border-b border-n-200 bg-n-50 px-6 py-3 text-sm text-n-700"
        >
          <p className="m-0 flex-1">
            “{entry?.title ?? owner?.entry.title}” changed on disk. Your draft is retained; any
            earlier acknowledged Save stays on disk.
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
