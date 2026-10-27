import { documentAdmission, waitForDocumentAdmission } from './documentAdmission';
import {
  finishSourceRequest,
  captureSourceAction,
  sourceRequestFor,
  sourceMayFocus,
  useSourceNavigation,
} from '@/app/sourceOpen';
import { revealSource, sourceUtf16Offset, hasSourcePropertyOwner } from './sourceReveal';
import { MentionLinkAction } from './MentionLinkAction';
import { resolveSource } from '@/lib/ipc';
import { splitFrontmatter } from '@/engine/frontmatter';
import { sourceBodyDisplay } from './sourceBodyEdits';
import { RecoverySaveStatus } from './RecoverySaveStatus';
import { useNavStore, usePaneId } from '@/stores/navStore';
import { Button } from '@/components/ui/Button';
import { StateMessage } from '@/components/ui/StateMessage';
import { useVaultActionGuard } from '@/hooks/useVaultActionGuard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRecoveryCapture, RecoveryBufferContext } from './recoveryBuffers';
import { createPortal } from 'react-dom';
import { useExtensionState } from '@blocknote/react';
import { PageTitleFallback } from './PageTitleFallback';
import { PageTitleProjection } from './pageTitleProjection';
import { readNote, readNoteSource, readEditorBody, saveNoteBody } from '@/lib/ipc';
import type {
  EditorSaveRequest,
  SelectedEditorTarget,
  SelectedEditorSnapshot,
} from '@/lib/generated/workspace';
import { sha256Hex } from '@/lib/sha256';
import { refusalText } from '@/lib/refusal';
import { useUiStore } from '@/stores/uiStore';
import {
  acceptSelectedEditorVersion,
  getVaultOpening,
  useVaultStore,
  type VaultState,
} from '@/stores/vaultStore';
import { LazyMarkdownEditor } from './LazyMarkdownEditor';
import type { ChoiceView, EditorReadyInfo } from './MarkdownEditor';
import { type LossyCause } from './markdown';
import { MergeChoices } from './MergeChoices';
import { sameSelectedObservation } from './selectedSnapshot';
import { NotePathContext } from './notePath';
import {
  holdEditor,
  onExternalWrite,
  registerSaveParticipant,
  retainDocumentOwner,
  retainedDocumentOwner,
  releaseDocumentOwner,
  documentPresentationOf,
} from './openPages';
import type { BodyFormat, DocumentOwner } from './documentOwner';
import { SourceBodyEditor } from './SourceBodyEditor';
import { sourceBodyFromFile } from './sourceBodyEdits';
import { firstH1LineIndex } from '@/engine/frontmatter';
import { isKnowledgePath } from '@/engine/okf';
import { bindSheetDrafts, detachSheetDrafts, settleSheetDrafts } from '@/sheet/pendingSheets';

function sameSelectedTarget(left?: SelectedEditorTarget, right?: SelectedEditorTarget): boolean {
  return left === undefined
    ? right === undefined
    : right !== undefined &&
        left.workspaceId === right.workspaceId &&
        left.recordId === right.recordId;
}
function selectedIdentity(target?: SelectedEditorTarget): string | null {
  return target === undefined ? null : JSON.stringify([target.workspaceId, target.recordId]);
}
/** Selected bodies are complete files. This adapter never applies the legacy
 * frontmatter or newline projection to the native snapshot. */
async function readBody(
  vault: string,
  path: string,
  format: BodyFormat,
  target?: SelectedEditorTarget,
) {
  if (target === undefined)
    return {
      text:
        format === 'source'
          ? sourceBodyFromFile((await readNoteSource(vault, path)).content)
          : await readNote(vault, path),
      selected: null,
    };
  const snapshot = await readEditorBody(vault, path, target);
  if (
    snapshot.path !== path ||
    !sameSelectedTarget(snapshot.target, target) ||
    !sameSelectedTarget(snapshot.version, target) ||
    snapshot.observedBodyHash !== sha256Hex(snapshot.body) ||
    (snapshot.coherence === 'paired' && snapshot.version.bodyHash !== snapshot.observedBodyHash)
  )
    throw new Error('The selected body response no longer identifies this page.');
  return { text: snapshot.body, selected: snapshot };
}
interface SelectedBodyPresentation {
  vault: string;
  path: string;
  identity: string | null;
  opening: number;
  observedBodyHash: string;
  canonicalBodyHash: string;
}
/** Read the live projection rather than caching title presence in the file
 * loader. The metadata portal remains mounted while editors load or refresh. */
function OwnedPageTitle(
  props: Omit<React.ComponentProps<typeof PageTitleFallback>, 'editor' | 'flushPendingSave'> & {
    owner: EditorReadyInfo;
  },
) {
  const titleId = useExtensionState(PageTitleProjection, {
    editor: props.owner.editor,
    selector: (state) => state.titleId,
  });
  if (titleId !== null) return null;
  return (
    <PageTitleFallback
      {...props}
      editor={props.owner.editor}
      flushPendingSave={props.owner.flushPendingSave}
    />
  );
}

/** Where the body currently stands relative to disk. */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'failed';

/** A save autosave did not write, while the page waits on a write, a
 * reconcile or the person's choice (M53.6, M55.6). */
interface Held {
  target: DocumentOwner;
  vault: string;
  path: string;
  markdown: string;
}

/**
 * The read-only banner's words for each reason a save would change the file
 * (`lossyImportCause`, M55.15). It once blamed raw HTML whatever the cause.
 */
const LOSSY_COPY: Record<LossyCause, { locked: string; unlocked: string; button: string }> = {
  html: {
    locked:
      "Parts of this file (raw HTML) can't be shown in the rich editor. It is open read-only so editing can't strip them.",
    unlocked: 'Editing enabled — saving this page will remove the raw HTML it contains.',
    button: 'Edit anyway (raw HTML will be removed)',
  },
  dropped: {
    locked:
      "Parts of this file can't be shown in the rich editor. It is open read-only so editing can't strip them.",
    unlocked: "Editing enabled — saving this page will remove the parts the editor can't show.",
    button: 'Edit anyway (those parts will be removed)',
  },
  added: {
    locked:
      "Saving this file from the rich editor would add text it doesn't have. It is open read-only.",
    unlocked: 'Editing enabled — saving this page will add that text.',
    button: 'Edit anyway (text will be added)',
  },
  rewritten: {
    locked: 'Saving this file from the rich editor would reorder its text. It is open read-only.',
    unlocked: 'Editing enabled — saving this page will reorder its text.',
    button: 'Edit anyway (text will be reordered)',
  },
};

/** The choice offered when a write the editor cannot show meets unsaved typing. */
const PAGE_CHOICE = 'page';

/**
 * Loads a note's body, shows the rich editor, and persists debounced edits.
 * Every save rescans, so editing the H1 syncs the entry title everywhere
 * (scanner derives titles from the first H1 — that IS the title sync).
 *
 * Reconciliation with the disk (M55.6). The editor is uncontrolled, so an
 * outside write (almost always the agent's) has to be brought into it, or
 * the next keystroke's save would put the old text back over it. The agent's
 * MCP writes announce their paths (`openPages.ts`); any other change shows as
 * a new content hash on the entry. Either way the page reads the body again
 * and, when it differs from `base` (what it last read or saved), applies it
 * in place: a clean page takes it block by block, and a page with unsaved
 * typing merges three ways, so only blocks both sides changed are left for
 * the person, as choices above the page. The caret, the scroll, the undo
 * history and every untouched block stay. While a write is pending, a
 * reconcile runs or a choice is open, autosave HOLDS what is typed, and
 * `release` writes the page as it stands once nothing holds. A leave waits
 * for that resolution; an unexpected unmount retains the unresolved draft.
 */
export function NoteBodyEditor({
  path,
  selectedTarget: requestedSelectedTarget,
  autoFocus = false,
  compact = false,
  owner,
  debounceMs,
  onReady,
  onSaveState,
  onBodyLoaded,
  readOnly = false,
  sections = false,
  pageChrome,
  pageTitle,
  bodyVisible,
}: {
  path: string;
  /** Explicit selected body adapter; native snapshots decide writer eligibility. */
  selectedTarget?: SelectedEditorTarget;
  /** The global peek owns its editor independently of its backdrop pane. */
  owner?: 'peek';
  autoFocus?: boolean;
  /** Narrow contexts (detail panel): smaller gutter and heading scale. */
  compact?: boolean;
  debounceMs?: number;
  onReady?: (info: EditorReadyInfo) => void;
  /** Save lifecycle, for a visible saved/unsaved indicator in the host. */
  onSaveState?: (state: SaveState) => void;
  /**
   * The body exactly as the disk returned it — on load, after each own save
   * (M50.1), and after an outside write the page took whole (M55.6). A
   * concept page pins Verify to it (M49.3): what a person attests is the text
   * they had on screen, and an edit of their own is part of that text once it
   * has landed.
   */
  onBodyLoaded?: (path: string, raw: string) => void;
  /** A file the person reads but does not write here — the knowledge log and
   *  cached sources are the system's. */
  readOnly?: boolean;
  /** `#` headings are sections, not the page title: a concept keeps its title
   *  in frontmatter (OKF), so its body's H1s render at section size. */
  sections?: boolean;
  pageChrome?: import('react').ReactNode;
  pageTitle?: string;
  bodyVisible?: boolean;
}) {
  const pane = usePaneId();
  const selectedRequested = requestedSelectedTarget !== undefined;
  const workspaceId = requestedSelectedTarget?.workspaceId;
  const recordId = requestedSelectedTarget?.recordId;
  const selectedTarget = useMemo(
    () =>
      selectedRequested
        ? Object.freeze({ workspaceId: workspaceId ?? '', recordId: recordId ?? '' })
        : undefined,
    [selectedRequested, workspaceId, recordId],
  );
  const identity = selectedIdentity(selectedTarget);
  const selectedRef = useRef(selectedTarget);
  selectedRef.current = selectedTarget;
  const [nativeEditable, setNativeEditable] = useState(true);
  const nativeEditableRef = useRef(nativeEditable);
  nativeEditableRef.current = nativeEditable;
  const [nativeReadOnlyReason, setNativeReadOnlyReason] = useState<string | null>(null);
  const [selectedBodyPresentation, setSelectedBodyPresentation] =
    useState<SelectedBodyPresentation | null>(null);
  const selectedBodyPresentationRef = useRef<SelectedBodyPresentation | null>(null);
  const acceptNativeEditability = useCallback((snapshot: SelectedEditorSnapshot) => {
    nativeEditableRef.current = snapshot.editable;
    setNativeEditable(snapshot.editable);
    setNativeReadOnlyReason(
      snapshot.editable
        ? null
        : (snapshot.readOnlyReason ?? 'This selected page is currently read-only.'),
    );
  }, []);
  const selectedChoice = useRef<{
    owner: DocumentOwner;
    requestKey: string;
    generation: number;
    snapshot: SelectedEditorSnapshot;
  } | null>(null);
  const choosingSelected = useRef(false);
  const selectedRetryChoice = useRef<DocumentOwner | null>(null);
  const [mode, setMode] = useState<BodyFormat>('rich');
  const modeRef = useRef<BodyFormat>('rich');
  const [sourceDraft, setSourceDraft] = useState('');
  const [modeError, setModeError] = useState<string | null>(null);
  const switching = useRef(false);
  const composing = useRef(false);
  const documentOwner = useRef<DocumentOwner | null>(null);
  const stopOwner = useRef<(() => void) | null>(null);
  const stopParticipant = useRef<(() => void) | null>(null);
  const [saveFailure, setSaveFailure] = useState(false);
  const [chromeHost] = useState(() => {
    const node = document.createElement('div');
    node.className = 'cb-page-editor-chrome';
    node.contentEditable = 'false';
    node.dataset.testid = 'page-editor-chrome';
    return node;
  });
  const [titleOwner, setTitleOwner] = useState<{
    path: string;
    gen: number;
    info: EditorReadyInfo;
  } | null>(null);
  const vaultPath = useVaultStore((s) => s.vaultPath);
  const scanObservation = useVaultStore((s) => s.scanObservation);
  const seenScan = useRef(scanObservation);
  useEffect(() => holdEditor(path, owner ?? pane, vaultPath), [path, owner, pane, vaultPath]);
  const rescan = useVaultStore((s) => s.rescan);
  const toast = useUiStore((s) => s.toast);
  // The body is stored WITH the path it was read from. The editor renders
  // only when they agree with the current prop — otherwise a path change
  // would mount the keyed editor with the PREVIOUS doc's body for one
  // render, and its unmount flush could write that body into the new file
  // (cross-doc corruption seen live in M2.x doc-polish testing).
  // `gen` counts the remounts outside writes still need: a locked page, and
  // a write the editor cannot show on a clean one. It travels WITH the body,
  // so a remount never shows the stale body while the re-read is in flight.
  const [loaded, setLoaded] = useState<{
    path: string;
    body: string;
    diskBody: string;
    restored: boolean;
    selectedIdentity: string | null;
    gen: number;
  } | null>(null);
  const previousRecoveryCapture = useRef<ReturnType<typeof createRecoveryCapture> | null>(null);
  const recoveryCapture = useMemo(() => {
    // A same-path selected record replacement is a different presentation.
    // The capture still binds only to a real owner, once; this descriptive
    // scope makes React detach the old child callbacks on that replacement.
    const scope = {
      vaultId: vaultPath,
      path: loaded?.path ?? path,
      ownerId: owner ?? pane,
      generation: loaded?.gen,
      selectedIdentity: identity,
    };
    return createRecoveryCapture(scope);
  }, [vaultPath, loaded?.path, loaded?.gen, owner, pane, path, identity]);
  // StrictMode ignores one memo calculation. Only replace the capture React
  // actually returned; detach the previous presentation before its cleanup.
  if (previousRecoveryCapture.current !== recoveryCapture) {
    previousRecoveryCapture.current?.detach();
    previousRecoveryCapture.current = recoveryCapture;
  }
  const captureTitleDraft = useCallback(
    (text: string | null) => recoveryCapture.set('page-title', text),
    [recoveryCapture],
  );
  const applyTitleDraft = useCallback(
    (apply: () => void) => recoveryCapture.commit('page-title', apply),
    [recoveryCapture],
  );
  const landRef = useRef<(draft: Held) => Promise<void>>(async () => {});
  const saveOwner = useCallback(
    (markdown: string) => {
      const target = recoveryCapture.owner();
      return target === null
        ? Promise.resolve()
        : landRef.current({ target, vault: target.key.vaultId, path: target.key.path, markdown });
    },
    [recoveryCapture],
  );
  const captureBodyDraft = useCallback(
    (markdown: string) => {
      recoveryCapture.owner()?.edit(markdown, 'rich');
    },
    [recoveryCapture],
  );
  const beginBodySave = useCallback(
    () => recoveryCapture.owner()?.beginPreparation() ?? (() => {}),
    [recoveryCapture],
  );
  const bodySaveDraft = useCallback(() => {
    const state = recoveryCapture.owner()?.snapshot();
    return state?.bodyFormat === 'source' ? state.latestDraft : null;
  }, [recoveryCapture]);
  const [failed, setFailed] = useState(false);
  const [lossy, setLossy] = useState<LossyCause | null>(null);
  const [generation, setGeneration] = useState(0);
  const [choices, setChoices] = useState<ChoiceView[]>([]);
  // The open choices, readable synchronously: a save deciding whether to
  // hold cannot wait for a render to learn one is open.
  const choicesRef = useRef<ChoiceView[]>([]);
  const showChoices = useCallback((next: ChoiceView[]) => {
    if (next.length === 0) selectedRetryChoice.current = null;
    choicesRef.current = next;
    setChoices(next);
  }, []);
  /** What the page last read or saved: the body as read, and its canonical
   *  text, which the editor's serialization is compared against. */
  const base = useRef<{ raw: string; canon: string } | null>(null);
  const setBase = (value: { raw: string; canon: string }) => {
    base.current = value;
    documentOwner.current?.setMergeBase(value);
  };
  /** The entry's content hash this page last heard: undefined until the
   *  load, null when the load found none. */
  const seenHash = useRef<string | null | undefined>(undefined);
  const publishSelectedBodyPresentation = useCallback((next: SelectedBodyPresentation | null) => {
    selectedBodyPresentationRef.current = next;
    setSelectedBodyPresentation(next);
    if (next !== null) seenHash.current = next.observedBodyHash;
  }, []);
  const acceptSelectedBodyObservation = useCallback(
    (vault: string, snapshot: SelectedEditorSnapshot) => {
      publishSelectedBodyPresentation({
        vault,
        path: snapshot.path,
        identity: selectedIdentity(snapshot.target),
        opening: getVaultOpening(),
        observedBodyHash: snapshot.observedBodyHash,
        canonicalBodyHash: snapshot.version.bodyHash,
      });
    },
    [publishSelectedBodyPresentation],
  );
  // Announced writes to this path still catching up.
  const externalPending = useRef(0);
  const held = useRef<Held | null>(null);
  /** The page has something to write once nothing holds: a held save, a
   *  merge with unsaved typing, or a choice. */
  const owed = useRef(false);
  /** The editor showing this path, once it is ready. */
  const ready = useRef<{ path: string; info: EditorReadyInfo } | null>(null);
  const [rereadFailure, setRereadFailure] = useState<{
    owner: DocumentOwner;
    editor: EditorReadyInfo;
    opening: number;
  } | null>(null);
  /** The reconcile running now; another is queued behind it at most. */
  const reconciling = useRef<Promise<void> | null>(null);
  // A complete reconciliation can start and finish while a source read
  // waits. Its promise may be null at both endpoints; retain its ordering.
  const reconcileEpoch = useRef(0);
  const queued = useRef(false);
  /** A trigger heard before the editor was ready. */
  const missed = useRef(false);
  const mounted = useRef(false);
  const pathRef = useRef(path);
  pathRef.current = path;
  const vaultRef = useRef(vaultPath);
  vaultRef.current = vaultPath;
  const entryHash = useVaultStore((s) => s.entries.find((e) => e.path === path)?.hash ?? null);
  // A lossy import mounts READ-ONLY. The old behaviour warned about the loss
  // and then let the very next keystroke autosave it away half a second
  // later — the warning was the entire mitigation. Editing is now an
  // explicit, undoable-by-choice act.
  const [unlocked, setUnlocked] = useState(false);
  // The same facts, for a reconcile that runs between renders.
  const lossyRef = useRef<LossyCause | null>(null);
  const unlockedRef = useRef(unlocked);
  unlockedRef.current = unlocked;
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const bodyVisibleRef = useRef(bodyVisible);
  bodyVisibleRef.current = bodyVisible;
  const isLocked = () =>
    readOnlyRef.current ||
    !nativeEditableRef.current ||
    (modeRef.current === 'rich' && lossyRef.current !== null && !unlockedRef.current);
  const titleDraftRef = useRef<(() => void) | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);

  const onSaveStateRef = useRef(onSaveState);
  onSaveStateRef.current = onSaveState;
  const onBodyLoadedRef = useRef(onBodyLoaded);
  onBodyLoadedRef.current = onBodyLoaded;
  const emitSaveState = useCallback((state: SaveState) => {
    onSaveStateRef.current?.(state);
  }, []);
  const startRecoveryLoad = useVaultActionGuard(
    JSON.stringify([vaultPath, path, owner ?? pane, identity]),
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    setFailed(false);
    setRereadFailure(null);
    setNativeEditable(selectedTarget === undefined);
    setNativeReadOnlyReason(null);
    composing.current = false;
    publishSelectedBodyPresentation(null);
    selectedChoice.current = null;
    setLossy(null);
    lossyRef.current = null;
    setUnlocked(false);
    showChoices([]);
    base.current = null;
    ready.current = null;
    seenHash.current = undefined;
    owed.current = false;
    emitSaveState('idle');
    if (vaultPath === null) return;
    let cancelled = false;
    const currentRecoveryLoad = startRecoveryLoad();
    const loadingKey = { vaultId: vaultPath, path, ownerId: owner ?? pane };
    const loadingOwner = retainedDocumentOwner(loadingKey);
    void (async () => {
      const key = { vaultId: vaultPath, path, ownerId: owner ?? pane };
      let text: string;
      for (;;) {
        if (
          !(await waitForDocumentAdmission(
            key,
            () =>
              !cancelled &&
              useVaultStore.getState().vaultPath === vaultPath &&
              (selectedTarget === undefined || currentRecoveryLoad()),
          ))
        )
          return;
        if (selectedTarget !== undefined && !currentRecoveryLoad()) return;
        // A read response does not prove it followed a retained owner's
        // acknowledgement. Bind it to the owner BEFORE issuing the read.
        const beforeOwner = retainedDocumentOwner(key);
        const before = beforeOwner?.snapshot();
        if (beforeOwner && !sameSelectedTarget(beforeOwner.selectedTarget, selectedTarget))
          throw new Error('The retained draft belongs to a different selected record.');
        // An existing original attempt already owns the local draft and base.
        // Reattach them without reading through native pending refusal or waiting
        // for a lost transport. This grants no new native write authority.
        if (
          selectedTarget !== undefined &&
          beforeOwner &&
          before &&
          (before.selectedSave !== undefined || before.inFlightGeneration !== null)
        ) {
          if (!before.mergeBase) throw new Error('The retained selected draft has no merge base.');
          text = before.mergeBase.raw;
          if (!cancelled) setNativeEditable(true);
          break;
        }
        const observed = await readBody(
          vaultPath,
          path,
          before?.bodyFormat ?? documentPresentationOf(key),
          selectedTarget,
        );
        if (selectedTarget !== undefined && !currentRecoveryLoad()) return;
        text = observed.text;
        if (cancelled) return;
        if (documentAdmission(key, beforeOwner).kind === 'deferred') continue;
        const afterOwner = retainedDocumentOwner(key) ?? beforeOwner;
        const after = afterOwner?.snapshot();
        const crossed =
          beforeOwner !== afterOwner ||
          (before !== undefined && before.inFlightGeneration !== null) ||
          (after !== undefined && after.inFlightGeneration !== null) ||
          before?.generation !== after?.generation ||
          before?.acknowledgedGeneration !== after?.acknowledgedGeneration ||
          before?.mergeBase !== after?.mergeBase ||
          before?.bodyFormat !== after?.bodyFormat;
        if (!crossed) {
          if (observed.selected) {
            acceptNativeEditability(observed.selected);
            acceptSelectedBodyObservation(vaultPath, observed.selected);
          }
          break;
        }
        // No presentation mounts with bytes read before this attempt.
        // Hold any coalesced generations, settle, then read disk again.
        afterOwner?.holdForReconcile();
        await afterOwner?.settleWrite();
        if (cancelled || (selectedTarget !== undefined && !currentRecoveryLoad())) return;
      }
      // Rust read_note returns the body verbatim including the blank line
      // after the frontmatter fence; the mock strips leading newlines —
      // normalize so both backends match (M1 note 10 discipline).
      if (cancelled || (selectedTarget !== undefined && !currentRecoveryLoad())) return;
      // Selected reads supplied their exact observed hash above. A retained
      // original with no new read has no new observation to stamp here.
      if (selectedTarget === undefined)
        seenHash.current =
          useVaultStore.getState().entries.find((e) => e.path === path)?.hash ?? null;
      const retained = retainedDocumentOwner({
        vaultId: vaultPath,
        path,
        ownerId: owner ?? pane,
      });
      const state = retained?.snapshot();
      // Retained draft and merge base must attach as a pair, even when an
      // old save made them clean while this presentation was unmounted.
      // Fresh disk bytes reconcile against that pair after attachment.
      const restored = state !== undefined;
      const format =
        state?.bodyFormat ??
        documentPresentationOf({ vaultId: vaultPath, path, ownerId: owner ?? pane });
      modeRef.current = format;
      setMode(format);
      setModeError(null);
      if (format === 'source') setSourceDraft(state?.latestDraft ?? text);
      const body = restored
        ? state.latestDraft
        : format === 'source'
          ? text
          : selectedTarget !== undefined
            ? text
            : text.replace(/^\n+/, '');
      setLoaded({
        path,
        body,
        diskBody:
          selectedTarget !== undefined || format === 'source' ? text : text.replace(/^\n+/, ''),
        restored,
        selectedIdentity: selectedIdentity(selectedTarget),
        gen: generation,
      });
      onBodyLoadedRef.current?.(path, text);
    })().catch(() => {
      if (!cancelled && (selectedTarget === undefined || currentRecoveryLoad())) {
        if (
          currentRecoveryLoad() &&
          loadingOwner?.recoveryResumePending() &&
          retainedDocumentOwner(loadingKey) === loadingOwner
        )
          loadingOwner.holdRecovery();
        setFailed(true);
        toast("Couldn't load page");
      }
    });
    return () => {
      cancelled = true;
    };
    // `generation` re-runs this effect to re-read from disk: the remounts
    // above, which take the file whole.
  }, [
    path,
    vaultPath,
    toast,
    emitSaveState,
    generation,
    showChoices,
    owner,
    pane,
    startRecoveryLoad,
    selectedTarget,
    acceptNativeEditability,
    acceptSelectedBodyObservation,
    publishSelectedBodyPresentation,
  ]);

  /** Write it, or hold it while the page waits on a write, a reconcile or a
   *  choice. */
  const land = (parked: Held): Promise<void> => {
    if (parked.target.recoveryRetired()) return Promise.resolve();
    if (
      mounted.current &&
      parked.path === pathRef.current &&
      documentOwner.current === parked.target &&
      (externalPending.current > 0 || reconciling.current !== null || choicesRef.current.length > 0)
    ) {
      held.current = parked;
      owed.current = true;
      emitSaveState('dirty');
      return Promise.resolve();
    }
    if (
      mounted.current &&
      parked.path === pathRef.current &&
      documentOwner.current === parked.target &&
      documentOwner.current?.snapshot().reconcileRequired === true
    ) {
      held.current = parked;
      owed.current = true;
      requestReconcile();
      return Promise.resolve();
    }
    return write(parked.target, parked.markdown);
  };
  landRef.current = land;

  /**
   * Write `markdown` to `forPath` now. Resolves once the save has landed, or
   * failed and said so; the rescan and pin that follow a landed save run on
   * behind it.
   */
  const write = async (target: DocumentOwner, markdown: string): Promise<void> => {
    if (target.recoveryRetired()) return;
    target.edit(markdown);
    const result = await target.flush();
    if (result.kind === 'failed')
      toast(
        `Couldn't save page: ${result.code.startsWith('recovery_required:') ? 'the recovery copy could not be stored. Retry save or choose to save without a copy.' : refusalText(result.code)}`,
      );
  };

  const acquireOwner = (vault: string, forPath: string, initial: string) => {
    const target = retainDocumentOwner(
      { vaultId: vault, path: forPath, ownerId: owner ?? pane },
      initial,
      async (
        markdown,
        bodyFormat: BodyFormat = 'rich',
        recoveryBypass?: string,
        _expectHash?: string,
        destination = target.key,
        editorRequest?: EditorSaveRequest,
      ) => {
        const writingPath = destination.path;
        const attached = () =>
          mounted.current &&
          documentOwner.current === target &&
          pathRef.current === forPath &&
          vaultRef.current === vault &&
          sameSelectedTarget(selectedRef.current, target.selectedTarget);
        const currentWriteOpening = startRecoveryLoad();
        const writeOpening = getVaultOpening();
        const writeGeneration = target.snapshot().inFlightGeneration;
        const previousPresentation = selectedBodyPresentationRef.current;
        const ack = await saveNoteBody({
          vault,
          path: writingPath,
          body: markdown,
          bodyFormat,
          recoveryBypass,
          ...(editorRequest === undefined ? {} : { editorRequest }),
        });
        if (ack.kind === 'selected_pending' || ack.kind === 'selected_outcome_unknown') return ack;
        let reconcile = false;
        if (ack.kind === 'selected_applied' || ack.kind === 'selected_unchanged') {
          const version = ack.kind === 'selected_applied' ? ack.currentVersion : ack.version;
          const selected = target.selectedTarget;
          // The original native acknowledgement remains valid across a view
          // change. A reopened view must reread before projection or draining N.
          const projected =
            selected !== undefined &&
            currentWriteOpening() &&
            acceptSelectedEditorVersion(vault, writingPath, selected, version);
          reconcile = !projected || (ack.kind === 'selected_applied' && ack.reconcileRequired);
          // This hold precedes returning the native acknowledgement to the
          // owner. Full width may not consume stale metadata properties.
          if (reconcile) target.holdForReconcile();
          if (projected && attached() && !reconcile && version.bodyHash === sha256Hex(markdown)) {
            seenHash.current = version.bodyHash;
            // The retained owner validates the original reply before it
            // acknowledges a generation. A malformed/Pending/Unknown reply
            // cannot clear this notice merely by carrying a version.
            void target.settleWrite().then(
              () => {
                const state = target.snapshot();
                const authority = useVaultStore
                  .getState()
                  .entries.find((entry) => entry.path === writingPath)?.authority;
                if (
                  !attached() ||
                  !currentWriteOpening() ||
                  getVaultOpening() !== writeOpening ||
                  selectedBodyPresentationRef.current !== previousPresentation ||
                  writeGeneration === null ||
                  state.acknowledgedGeneration !== writeGeneration ||
                  state.selectedSave !== undefined ||
                  state.mergeBase?.raw !== markdown ||
                  authority?.workspaceId !== version.workspaceId ||
                  authority.recordId !== version.recordId ||
                  authority.metadataRevision !== version.metadataRevision ||
                  authority.metadataHash !== version.metadataHash ||
                  authority.bodyHash !== version.bodyHash
                )
                  return;
                publishSelectedBodyPresentation({
                  vault,
                  path: writingPath,
                  identity: selectedIdentity(selected),
                  opening: writeOpening,
                  observedBodyHash: version.bodyHash,
                  canonicalBodyHash: version.bodyHash,
                });
              },
              () => {
                // A failed settlement leaves the last known observation.
              },
            );
          }
        }
        // Refresh observes an already authoritative acknowledgement. It never
        // changes its durability result or releases a hold without a fresh read.
        const currentObservation = startRecoveryLoad();
        void (async () => {
          try {
            await rescan();
          } catch {
            if (target.selectedTarget === undefined || currentObservation())
              toast("Couldn't refresh vault");
          }
          if (!attached() || (target.selectedTarget !== undefined && !currentObservation())) return;
          if (reconcile) {
            requestReconcile();
            return;
          }
          if (onBodyLoadedRef.current !== undefined) {
            try {
              const text =
                target.selectedTarget === undefined
                  ? await readNote(vault, forPath)
                  : (await readBody(vault, forPath, bodyFormat, target.selectedTarget)).text;
              if (attached() && (target.selectedTarget === undefined || currentObservation()))
                onBodyLoadedRef.current?.(forPath, text);
            } catch {
              /* Retain the last attested body. */
            }
          }
        })();
        return ack;
      },
      selectedTarget,
    );
    target.setWriteGate(() => {
      if (
        !mounted.current ||
        pathRef.current !== forPath ||
        !sameSelectedTarget(selectedRef.current, target.selectedTarget)
      )
        return null;
      if (choicesRef.current.length > 0) return 'choice';
      if (switching.current) return 'reconcile';
      if (externalPending.current > 0 || reconciling.current !== null) return 'reconcile';
      return null;
    });
    return target;
  };

  /**
   * Once nothing holds: drop the held save and write the page as it stands,
   * when that differs from the base. A merge, a held save and a choice all
   * end here.
   */
  const release = () => {
    if (
      !owed.current ||
      externalPending.current > 0 ||
      reconciling.current !== null ||
      choicesRef.current.length > 0 ||
      documentOwner.current?.snapshot().reconcileRequired === true ||
      documentOwner.current?.snapshot().selectedSave !== undefined
    ) {
      return;
    }
    owed.current = false;
    held.current = null;
    const at = ready.current;
    const was = base.current;
    const vault = vaultRef.current;
    if (at === null || was === null || vault === null || at.path !== pathRef.current) return;
    if (isLocked()) return;
    const md =
      modeRef.current === 'source'
        ? (documentOwner.current?.snapshot().latestDraft ?? '')
        : at.info.serialize();
    at.info.markSaved(md);
    // Equal observed text cannot acknowledge an explicit canonical-adoption
    // intent. After terminal resolution, this drain starts a fresh request.
    if (
      documentOwner.current !== null &&
      (md !== was.canon || documentOwner.current.hasSelectedTextIntent())
    )
      void write(documentOwner.current, md);
    else {
      documentOwner.current?.acceptExternal(md, was);
      emitSaveState('saved');
    }
  };

  /** Take the file whole: a locked page, or a write the editor cannot show. */
  const remount = () => {
    cancelRef.current?.();
    held.current = null;
    owed.current = false;
    showChoices([]);
    if (documentOwner.current !== null) {
      const target = documentOwner.current;
      if (target.acceptExternal(base.current?.raw ?? target.snapshot().latestDraft)) {
        // Taking the file whole deliberately replaces this presentation. The
        // settled reconcile must release its old owner before the fresh load.
        target.finishReconcile();
        releaseDocumentOwner(target);
      }
    }
    setGeneration((g) => g + 1);
  };

  /** Read the file and bring what changed into the page. */
  const reconcileOnce = async (): Promise<boolean> => {
    const ownsPresentation = startRecoveryLoad();
    const opening = getVaultOpening();
    const currentRecoveryLoad = () => ownsPresentation() && getVaultOpening() === opening;
    const at = ready.current;
    const vault = vaultRef.current;
    if (at === null || vault === null) return false;
    const target = documentOwner.current;
    await target?.settleWrite();
    if (
      !mounted.current ||
      ready.current !== at ||
      documentOwner.current !== target ||
      (target?.selectedTarget !== undefined && !currentRecoveryLoad())
    )
      return false;
    if (
      target?.selectedTarget !== undefined &&
      (target.snapshot().selectedSave?.status === 'pending' ||
        target.snapshot().selectedSave?.status === 'unknown')
    )
      return false;
    const before = target?.snapshot();
    let observed: Awaited<ReturnType<typeof readBody>>;
    try {
      observed = await readBody(vault, at.path, modeRef.current, target?.selectedTarget);
    } catch {
      if (
        currentRecoveryLoad() &&
        documentOwner.current === target &&
        target?.recoveryResumePending()
      )
        target.holdRecovery();
      if (
        mounted.current &&
        ready.current === at &&
        documentOwner.current === target &&
        sameSelectedTarget(selectedRef.current, target?.selectedTarget) &&
        (target?.selectedTarget === undefined || currentRecoveryLoad())
      ) {
        if (target?.selectedTarget !== undefined)
          setRereadFailure({ owner: target, editor: at.info, opening });
        toast("Couldn't reload page");
      }
      return false;
    }
    if (
      !mounted.current ||
      (target?.selectedTarget !== undefined && !currentRecoveryLoad()) ||
      ready.current !== at ||
      documentOwner.current !== target ||
      vaultRef.current !== vault ||
      !sameSelectedTarget(selectedRef.current, target?.selectedTarget)
    )
      return false;
    if (observed.selected && target) {
      const after = target.snapshot();
      if (
        before?.generation !== after.generation ||
        before?.acknowledgedGeneration !== after.acknowledgedGeneration ||
        before?.bodyFormat !== after.bodyFormat ||
        before?.mergeBase !== after.mergeBase ||
        after.inFlightGeneration !== null
      ) {
        queued.current = true;
        return true;
      }
      acceptNativeEditability(observed.selected);
      if (after.selectedSave?.status === 'reconcile') {
        setRereadFailure(null);
        acceptSelectedBodyObservation(vault, observed.selected);
        // OutcomeUnknown is never a normal merge. Even non-overlapping edits
        // require the existing whole-page choice before a new attempt is born.
        titleDraftRef.current?.();
        const current = target.snapshot();
        selectedChoice.current = {
          owner: target,
          requestKey: after.selectedSave.requestKey,
          generation: current.generation,
          snapshot: observed.selected,
        };
        owed.current = true;
        showChoices([
          { id: PAGE_CHOICE, mine: current.latestDraft, theirs: observed.text, firstBlockId: null },
        ]);
        return true;
      }
      const selected = target.selectedTarget;
      if (
        selected === undefined ||
        !acceptSelectedEditorVersion(vault, at.path, selected, observed.selected.version)
      )
        return false;
      acceptSelectedBodyObservation(vault, observed.selected);
      setRereadFailure(null);
    }
    const text = observed.text;
    const raw = observed.selected || modeRef.current === 'source' ? text : text.replace(/^\n+/, '');
    const was = target?.snapshot().mergeBase ?? base.current;
    if (was !== null && was !== undefined) base.current = was;
    // An own save, or a change to the frontmatter alone.
    if (was === null || was === undefined || raw === was.raw) return true;
    if (observed.selected && target?.hasSelectedTextIntent()) {
      // In either view, equality with the draft proves observed bytes only.
      // The native receipt or an explicit choice still owns this intent.
      const state = target.snapshot();
      selectedRetryChoice.current = target;
      setBase({ raw, canon: raw });
      owed.current = true;
      showChoices([{ id: PAGE_CHOICE, mine: state.latestDraft, theirs: raw, firstBlockId: null }]);
      return true;
    }
    if (modeRef.current === 'source' && target !== null) {
      const state = target.snapshot();
      if (state.generation === state.acknowledgedGeneration || raw === state.latestDraft) {
        if (!target.acceptExternal(raw, { raw, canon: raw })) return false;
        setBase({ raw, canon: raw });
        setSourceDraft(raw);
        showChoices([]);
        onBodyLoadedRef.current?.(at.path, text);
      } else {
        setBase({ raw, canon: raw });
        owed.current = true;
        showChoices([
          { id: PAGE_CHOICE, mine: state.latestDraft, theirs: raw, firstBlockId: null },
        ]);
      }
      return true;
    }
    if (isLocked()) {
      remount();
      return true;
    }
    // An IME may still own the filename fallback's local composition. Move
    // that exact draft into this editor before merging outside bytes, so the
    // same reconcile can preserve it or present a choice rather than unmount
    // the field underneath the person's composition.
    titleDraftRef.current?.();
    const result = at.info.applyExternal(raw, was.canon, {
      allowLoss: lossyRef.current !== null && unlockedRef.current,
    });
    switch (result.kind) {
      case 'same':
        setBase({ raw, canon: was.canon });
        return true;
      case 'applied':
        if (result.after !== result.next && !result.dirty) {
          // A clean page that did not come out as the write: never save it
          // over the file, take the file whole.
          remount();
          return true;
        }
        setBase({ raw, canon: result.next });
        showChoices([]);
        if (result.after === result.next) {
          documentOwner.current?.acceptExternal(result.after, { raw, canon: result.next });
          onBodyLoadedRef.current?.(at.path, text);
        } else {
          documentOwner.current?.edit(result.after);
          owed.current = true;
        }
        return true;
      case 'choices':
        setBase({ raw, canon: result.next });
        owed.current = true;
        showChoices(result.choices);
        return true;
      case 'unrepresentable':
        if (!result.dirty) {
          remount();
          return true;
        }
        // Nothing of the write can land without losing text, and the page
        // holds typing: the whole page is the choice.
        setBase({ raw, canon: was.canon });
        owed.current = true;
        showChoices([
          ...choicesRef.current.filter((choice) => choice.id !== PAGE_CHOICE),
          { id: PAGE_CHOICE, mine: at.info.serialize(), theirs: raw, firstBlockId: null },
        ]);
        return true;
    }
  };

  // Through refs: the reconcile loop outlives the render that started it.
  const reconcileRef = useRef(reconcileOnce);
  reconcileRef.current = reconcileOnce;
  const releaseRef = useRef(release);
  releaseRef.current = release;

  /** Reconcile now, or after the one running; once ready, if not yet. */
  const requestReconcile = useCallback(() => {
    reconcileEpoch.current += 1;
    if (ready.current === null || ready.current.path !== pathRef.current) {
      missed.current = true;
      return;
    }
    if (reconciling.current !== null) {
      queued.current = true;
      return;
    }
    const target = documentOwner.current;
    target?.holdForReconcile();
    let confirmed = false;
    const run: Promise<void> = (async () => {
      do {
        queued.current = false;
        confirmed = await reconcileRef.current();
        if (!confirmed) break;
      } while (queued.current && mounted.current);
    })().finally(() => {
      if (reconciling.current === run) reconciling.current = null;
      if (confirmed && documentOwner.current === target) target?.finishReconcile();
      releaseRef.current();
    });
    reconciling.current = run;
  }, []);

  // Failed selected scans cannot change Entry hashes. Observe their terminal
  // outcome directly, synchronously holding the same owner before a pending
  // write can drain newer typing. The store, not this page, owns the watcher.
  useEffect(() => {
    if (selectedTarget === undefined) return;
    const observe = (state: VaultState) => {
      const observation = state.scanObservation;
      const previous = seenScan.current;
      if (observation === previous) return;
      seenScan.current = observation;
      const selected = selectedRef.current;
      if (
        !mounted.current ||
        observation == null ||
        observation.opening !== getVaultOpening() ||
        observation.vault !== vaultRef.current ||
        state.vaultPath !== observation.vault ||
        state.entriesVault !== observation.vault ||
        state.status !== 'ready' ||
        selected === undefined
      )
        return;
      const entry = state.entries.find((candidate) => candidate.path === pathRef.current);
      if (
        entry?.authority?.kind !== 'sqlite_metadata' ||
        !sameSelectedTarget(entry.authority, selected) ||
        (documentOwner.current !== null &&
          !sameSelectedTarget(documentOwner.current.selectedTarget, selected))
      )
        return;
      // Compare observed bytes and canonical pairing independently. A paired
      // scan can change only the latter, and a recovered refresh must settle
      // its earlier unavailable observation even when neither hash changed.
      if (
        observation.outcome === 'scanned' &&
        !(previous?.opening === observation.opening && previous.outcome === 'unavailable') &&
        documentOwner.current?.snapshot().reconcileRequired !== true &&
        selectedBodyPresentationRef.current?.canonicalBodyHash === entry.authority.bodyHash &&
        selectedBodyPresentationRef.current.observedBodyHash === entry.hash
      )
        return;
      // Only a completed scan observed these bytes. A failed scan must not
      // stamp its retained Entry over the editor's fresher body observation.
      if (observation.outcome === 'scanned') seenHash.current = entry.hash;
      // An announced write owns its own settled callback and already holds
      // this owner. Read only once that existing announcement has caught up.
      if (externalPending.current === 0) requestReconcile();
    };
    const stop = useVaultStore.subscribe(observe);
    // Cover a completion between render and subscription, including one
    // before the lazy editor is ready; requestReconcile retains that miss.
    observe(useVaultStore.getState());
    return stop;
  }, [identity, path, vaultPath, selectedTarget, requestReconcile]);

  // A change of the file's content, from anyone. The agent's announced
  // writes are settled by their announcement (below), which knows when the
  // vault has caught up.
  useEffect(() => {
    // A null hash is a write in flight (setTitle clears it before it writes):
    // keep the last one seen, so the hash after it reads as a change. Before
    // the load, the load reads the hash itself.
    if (entryHash === null || seenHash.current === undefined) return;
    if (entryHash === seenHash.current) return;
    seenHash.current = entryHash;
    if (externalPending.current === 0) requestReconcile();
  }, [entryHash, path, requestReconcile]);

  // An agent wrote THIS file (M53.6). Saves hold from the announcement; once
  // the vault has caught up with the last of a burst, the page reconciles.
  useEffect(() => {
    let live = true;
    const stop = onExternalWrite(path, {
      pending: () => {
        if (live && (!documentOwner.current || documentOwner.current.key.path === path)) {
          externalPending.current += 1;
          const target = documentOwner.current;
          target?.holdForReconcile();
          const state = target?.snapshot();
          if (
            state !== undefined &&
            (state.generation > state.acknowledgedGeneration || state.inFlightGeneration !== null)
          )
            owed.current = true;
        }
      },
      settled: () => {
        if (!live || (documentOwner.current && documentOwner.current.key.path !== path)) return;
        externalPending.current = Math.max(0, externalPending.current - 1);
        if (externalPending.current > 0) return;
        requestReconcile();
        // Nothing to read if the editor is not up yet; a save held meanwhile
        // still lands.
        releaseRef.current();
      },
    });
    return () => {
      live = false;
      externalPending.current = 0;
      stop();
    };
  }, [path, requestReconcile]);

  // Saves target the path the body was LOADED for, never the current prop —
  // a debounce flush racing a navigation must land in its own file.

  // Normal leaves inspect the mounted participant first. Forced retirement
  // must retain a choice, never turn unmount into an implicit "Keep mine".
  useEffect(
    () => () => {
      const target = documentOwner.current;
      if (
        target !== null &&
        (held.current !== null ||
          choicesRef.current.length > 0 ||
          externalPending.current > 0 ||
          reconciling.current !== null)
      )
        target.holdForReconcile();
      stopParticipant.current?.();
      stopOwner.current?.();
      if (target !== null) releaseDocumentOwner(target, path);
      if (target?.selectedTarget !== undefined && documentOwner.current === target)
        documentOwner.current = null;
      held.current = null;
    },
    [path, identity],
  );

  /** An explicit terminal-unknown choice reads again at the click. Neither a
   * changed draft nor a changed current page may be silently substituted. */
  const pickSelected = async (which: 'mine' | 'theirs') => {
    const choice = selectedChoice.current;
    const at = ready.current;
    const vault = vaultRef.current;
    if (choice === null || at === null || vault === null || choosingSelected.current) return;
    const target = choice.owner;
    const attached = () =>
      mounted.current &&
      documentOwner.current === target &&
      ready.current === at &&
      vaultRef.current === vault &&
      pathRef.current === at.path &&
      sameSelectedTarget(selectedRef.current, target.selectedTarget);
    if (!attached() || target.selectedTarget === undefined) return;
    try {
      titleDraftRef.current?.();
    } catch {
      setModeError('The page title could not be prepared. Your draft is still kept.');
      return;
    }
    try {
      settleSheetDrafts(at.info.editor);
    } catch {
      setModeError(
        'Resolve the unsaved sheet cell before choosing a version. Your draft is still kept.',
      );
      return;
    }
    setModeError(null);
    const before = target.snapshot();
    if (
      before.selectedSave?.status !== 'reconcile' ||
      before.selectedSave.requestKey !== choice.requestKey ||
      before.inFlightGeneration !== null ||
      Object.keys(before.childDrafts ?? {}).length
    )
      return;
    const refresh = (observed: SelectedEditorSnapshot) => {
      const state = target.snapshot();
      selectedChoice.current = {
        owner: target,
        requestKey: choice.requestKey,
        generation: state.generation,
        snapshot: observed,
      };
      showChoices([
        { id: PAGE_CHOICE, mine: state.latestDraft, theirs: observed.body, firstBlockId: null },
      ]);
    };
    if (before.generation !== choice.generation) {
      refresh(choice.snapshot);
      return;
    }
    const currentOpening = startRecoveryLoad();
    choosingSelected.current = true;
    try {
      const observed = (await readBody(vault, at.path, modeRef.current, target.selectedTarget))
        .selected;
      if (
        !currentOpening() ||
        !attached() ||
        observed === null ||
        selectedChoice.current !== choice
      )
        return;
      acceptNativeEditability(observed);
      const current = target.snapshot();
      if (
        current.selectedSave?.status !== 'reconcile' ||
        current.selectedSave.requestKey !== choice.requestKey
      )
        return;
      if (
        current.generation !== before.generation ||
        !sameSelectedObservation(choice.snapshot, observed)
      ) {
        refresh(observed);
        return;
      }
      if (
        !target.settleSelectedReconcile({
          requestKey: choice.requestKey,
          generation: before.generation,
          snapshot: observed,
          choice: which,
        })
      ) {
        if (which === 'mine' && !observed.editable)
          setModeError(observed.readOnlyReason ?? 'This selected page is currently read-only.');
        return;
      }
      selectedChoice.current = null;
      acceptNativeEditability(observed);
      acceptSelectedBodyObservation(vault, observed);
      base.current = target.snapshot().mergeBase ?? { raw: observed.body, canon: observed.body };
      showChoices([]);
      if (which === 'mine') {
        owed.current = true;
        release();
        return;
      }
      cancelRef.current?.();
      held.current = null;
      owed.current = false;
      at.info.markSaved(observed.body);
      const projected = acceptSelectedEditorVersion(
        vault,
        at.path,
        target.selectedTarget,
        observed.version,
      );
      if (projected) seenHash.current = observed.observedBodyHash;
      else {
        target.holdForReconcile();
        void (async () => {
          try {
            await rescan();
          } catch {
            toast("Couldn't refresh vault");
          }
          if (attached()) requestReconcile();
        })();
      }
      if (modeRef.current === 'source') setSourceDraft(observed.body);
      else setGeneration((value) => value + 1);
      onBodyLoadedRef.current?.(at.path, observed.body);
    } catch {
      if (currentOpening() && attached())
        setModeError('The current page could not be rechecked. Your draft is still kept.');
    } finally {
      choosingSelected.current = false;
    }
  };

  /** Settle a row of the choice bar. */
  const pick = (id: string, which: 'mine' | 'theirs') => {
    const at = ready.current;
    if (at === null) return;
    if (id === PAGE_CHOICE && selectedChoice.current !== null) {
      void pickSelected(which);
      return;
    }
    if (
      id === PAGE_CHOICE &&
      which === 'mine' &&
      selectedRetryChoice.current !== null &&
      selectedRetryChoice.current === documentOwner.current &&
      selectedRetryChoice.current.hasSelectedTextIntent()
    ) {
      const target = selectedRetryChoice.current;
      const currentOpening = startRecoveryLoad();
      const opening = getVaultOpening();
      const vault = vaultRef.current;
      const selected = selectedRef.current;
      const observed = selectedBodyPresentationRef.current;
      const workspace = useVaultStore.getState();
      const entry = workspace.entries.find((candidate) => candidate.path === pathRef.current);
      const state = target.snapshot();
      // A blocked click keeps its choice and grants no future retry. There
      // is no wait between this live proof and the existing owner drain.
      if (
        !currentOpening() ||
        getVaultOpening() !== opening ||
        !mounted.current ||
        documentOwner.current !== target ||
        ready.current !== at ||
        vault === null ||
        target.key.vaultId !== vault ||
        target.key.path !== pathRef.current ||
        at.path !== pathRef.current ||
        selected === undefined ||
        !sameSelectedTarget(selected, target.selectedTarget) ||
        entry?.authority?.kind !== 'sqlite_metadata' ||
        !sameSelectedTarget(entry.authority, selected) ||
        workspace.vaultPath !== vault ||
        workspace.entriesVault !== vault ||
        workspace.status !== 'ready' ||
        observed === null ||
        observed.vault !== vault ||
        observed.path !== at.path ||
        observed.identity !== selectedIdentity(selected) ||
        observed.opening !== opening ||
        isLocked() ||
        bodyUnavailable ||
        composing.current ||
        at.info.editor.prosemirrorView?.composing === true ||
        switching.current ||
        choosingSelected.current ||
        externalPending.current > 0 ||
        reconciling.current !== null ||
        target.recoveryBusy() ||
        target.recoveryRetired() ||
        state.reconcileRequired === true ||
        state.selectedSave !== undefined ||
        state.inFlightGeneration !== null ||
        Object.keys(state.childDrafts ?? {}).length > 0 ||
        state.bodyFormat !== modeRef.current ||
        choicesRef.current.length !== 1 ||
        choicesRef.current[0]?.id !== PAGE_CHOICE
      )
        return;
      try {
        if (modeRef.current === 'rich' && at.info.serialize() !== state.latestDraft) return;
      } catch {
        return;
      }
      cancelRef.current?.();
      held.current = null;
      owed.current = false;
      showChoices([]);
      // The frozen raw payload/key also handles a formatting-only outside
      // change whose text equals the visible canonical rich presentation.
      void target.retry();
      return;
    }
    if (id === PAGE_CHOICE && modeRef.current === 'source') {
      const choice = choicesRef.current.find((item) => item.id === id);
      const target = documentOwner.current;
      if (choice === undefined || target === null) return;
      if (which === 'theirs') {
        target.acceptExternal(choice.theirs, { raw: choice.theirs, canon: choice.theirs });
        target.finishReconcile();
        setSourceDraft(choice.theirs);
      }
      showChoices([]);
      release();
      return;
    }
    if (id === PAGE_CHOICE) {
      // The new version, whole: what was typed is discarded, so the pending
      // debounce and the held save go before the remount.
      if (which === 'theirs') {
        remount();
        return;
      }
      showChoices(choicesRef.current.filter((choice) => choice.id !== PAGE_CHOICE));
    } else {
      const page = choicesRef.current.filter((choice) => choice.id === PAGE_CHOICE);
      showChoices([...at.info.choose(id, which), ...page]);
    }
    release();
  };

  const switchMode = async (next: BodyFormat, allowLoss = false) => {
    const target = documentOwner.current;
    const at = ready.current;
    const vault = vaultRef.current;
    if (
      target === null ||
      at === null ||
      vault === null ||
      switching.current ||
      next === modeRef.current
    )
      return;
    const currentOpening = startRecoveryLoad();
    const attached = () =>
      (target.selectedTarget === undefined || currentOpening()) &&
      mounted.current &&
      documentOwner.current === target &&
      ready.current === at &&
      vaultRef.current === vault &&
      pathRef.current === at.path &&
      sameSelectedTarget(selectedRef.current, target.selectedTarget);
    if (next === 'source' && isKnowledgePath(path)) {
      setModeError('Source editing is unavailable for governed knowledge pages.');
      return;
    }
    if (
      target.snapshot().selectedSave !== undefined ||
      (target.selectedTarget !== undefined && target.snapshot().inFlightGeneration !== null) ||
      choicesRef.current.length ||
      externalPending.current ||
      reconciling.current
    ) {
      setModeError('Resolve the pending page update before switching presentation.');
      return;
    }
    switching.current = true;
    setModeError(null);
    let reconcileAfterSwitch = false;
    try {
      titleDraftRef.current?.();
      settleSheetDrafts(at.info.editor);
      if (Object.keys(target.snapshot().childDrafts ?? {}).length)
        throw new Error('Resolve the unsaved sheet cell before switching presentation.');
      await target.settleWrite();
      if (!attached()) return;
      if (next === 'source') {
        let snapshot: Awaited<ReturnType<typeof readBody>>;
        let state: ReturnType<DocumentOwner['snapshot']>;
        for (;;) {
          await target.settleWrite();
          await reconciling.current;
          if (!attached()) return;
          if (choicesRef.current.length || externalPending.current)
            throw new Error('Resolve the pending page update before switching presentation.');
          const before = target.snapshot();
          const epoch = reconcileEpoch.current;
          const presentation = modeRef.current;
          snapshot = await readBody(vault, at.path, 'source', target.selectedTarget);
          if (!attached()) return;
          state = target.snapshot();
          if (
            before.inFlightGeneration !== null ||
            state.inFlightGeneration !== null ||
            before.generation !== state.generation ||
            before.acknowledgedGeneration !== state.acknowledgedGeneration ||
            before.mergeBase !== state.mergeBase ||
            before.latestDraft !== state.latestDraft ||
            before.bodyFormat !== state.bodyFormat ||
            presentation !== modeRef.current ||
            epoch !== reconcileEpoch.current ||
            reconciling.current !== null ||
            externalPending.current > 0
          )
            continue;
          // This response belongs to the same causal owner state that
          // requested it. Crossed writes/reconciliations require a fresh
          // read, even if the latest owner is now clean again.
          break;
        }
        const observed = snapshot.text;
        if (snapshot.selected) {
          acceptNativeEditability(snapshot.selected);
          acceptSelectedBodyObservation(vault, snapshot.selected);
        }
        const clean = state.generation === state.acknowledgedGeneration;
        const raw = clean
          ? observed
          : target.selectedTarget !== undefined && state.latestDraft === state.mergeBase?.canon
            ? (state.mergeBase?.raw ?? state.latestDraft)
            : state.latestDraft;
        if (clean) setBase({ raw, canon: raw });
        else if (
          target.selectedTarget !== undefined
            ? observed !== state.mergeBase?.raw
            : observed.replace(/^\n+/, '') !== state.mergeBase?.raw.replace(/^\n+/, '')
        ) {
          // This fresh read can discover an outside write before its scan or
          // announcement arrives. Keep the local draft and reconcile again
          // in source mode before the existing timer may drain it.
          target.holdForReconcile();
          reconcileAfterSwitch = true;
        }
        target.present(raw, 'source');
        setSourceDraft(raw);
      } else {
        let raw: string;
        let projection: { lossy: LossyCause | null; canonical: string };
        do {
          raw = target.snapshot().latestDraft;
          projection = await at.info.presentMarkdown(raw, allowLoss);
          if (!attached()) return;
          // Parsing yields to input. A later source edit must receive its
          // own validation before any rich projection replaces its owner.
        } while (raw !== target.snapshot().latestDraft);
        if (projection.lossy !== null && !allowLoss) {
          setModeError(
            'This source cannot be represented in rich text without changing its content.',
          );
          return;
        }
        target.present(projection.canonical, 'rich');
        setBase({ raw: target.snapshot().mergeBase?.raw ?? raw, canon: projection.canonical });
        lossyRef.current = projection.lossy;
        setLossy(projection.lossy);
        if (projection.lossy !== null) {
          unlockedRef.current = true;
          setUnlocked(true);
        }
      }
      modeRef.current = next;
      setMode(next);
      if (reconcileAfterSwitch) requestReconcile();
    } catch (error) {
      if (attached()) setModeError(error instanceof Error ? error.message : String(error));
    } finally {
      switching.current = false;
      const state = target.snapshot();
      if (attached() && state.generation > state.acknowledgedGeneration && state.failure === null)
        at.info.schedulePendingSave();
    }
  };

  const sourceOwner = owner ?? pane;
  // The selector follows this editor's actual visit/peek, including a reused
  // holder. Status is retained with that visit; a request executes once.
  const sourceRequest = useNavStore(() => sourceRequestFor(path, sourceOwner));
  const sourceRoot = useRef<HTMLDivElement>(null);
  const { returnToSourceOrigin } = useSourceNavigation();
  const [returnUnavailable, setReturnUnavailable] = useState(false);
  useEffect(() => {
    if (!sourceRequest || sourceRequest.status || sourceRequest.locator.kind !== 'property') return;
    if (selectedTarget !== undefined) {
      finishSourceRequest(path, sourceOwner, sourceRequest.requestId, 'unsupported');
      return;
    }
    if (!titleOwner || titleOwner.path !== path) return;
    const frame = requestAnimationFrame(() => {
      if (!hasSourcePropertyOwner(path, sourceOwner))
        finishSourceRequest(path, sourceOwner, sourceRequest.requestId, 'unsupported');
    });
    return () => cancelAnimationFrame(frame);
  }, [sourceRequest, sourceOwner, path, titleOwner, selectedTarget]);

  useEffect(() => {
    if (!sourceRequest || sourceRequest.status || sourceRequest.locator.kind !== 'body') return;
    if (selectedTarget !== undefined) {
      finishSourceRequest(path, sourceOwner, sourceRequest.requestId, 'unsupported');
      return;
    }
    if (!titleOwner || titleOwner.path !== path || !vaultPath) return;
    let cancelled = false;
    const current = () =>
      !cancelled && sourceRequestFor(path, sourceOwner)?.requestId === sourceRequest.requestId;
    const finish = (status: import('@/app/sourceOpen').SourceRevealStatus) => {
      if (current()) finishSourceRequest(path, sourceOwner, sourceRequest.requestId, status);
    };
    void (async () => {
      if (bodyVisible === false) {
        finish('unsupported');
        return;
      }
      const resolved = await resolveSource(vaultPath, sourceRequest.locator);
      if (!current()) return;
      if (resolved.status !== 'exact' && resolved.status !== 'relocated') {
        finish(resolved.status);
        return;
      }
      const snapshot = await readNoteSource(vaultPath, path);
      if (!current()) return;
      if (!sourceMayFocus(sourceRequest, sourceOwner)) {
        finish('cancelled');
        return;
      }
      const body = splitFrontmatter(snapshot.content).body;
      const state = documentOwner.current?.snapshot();
      if (
        snapshot.hash !== resolved.locator.sourceHash ||
        state?.generation !== state?.acknowledgedGeneration ||
        reconciling.current ||
        externalPending.current > 0 ||
        choicesRef.current.length > 0
      ) {
        finish('changed');
        return;
      }
      if (modeRef.current === 'source') {
        const textarea = sourceRoot.current?.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Page source"]',
        );
        const range = resolved.locator.bodyUtf8Range;
        if (!textarea || !range) {
          finish('unsupported');
          return;
        }
        if (sourceDraft !== body) {
          finish('changed');
          return;
        }
        const start = sourceUtf16Offset(body, range.start),
          end = sourceUtf16Offset(body, range.end);
        if (start === null || end === null || body.slice(start, end) !== resolved.locator.quote) {
          finish('changed');
          return;
        }
        textarea.focus();
        textarea.setSelectionRange(
          sourceBodyDisplay(body.slice(0, start)).length,
          sourceBodyDisplay(body.slice(0, end)).length,
        );
        textarea.scrollIntoView({ block: 'center' });
        finish(resolved.status === 'relocated' ? 'relocated' : 'revealed');
        return;
      }
      const info = titleOwner.info;
      if (
        body.replace(/^\n+/, '') !== base.current?.raw.replace(/^\n+/, '') ||
        info.serialize() !== base.current?.canon
      ) {
        finish('changed');
        return;
      }
      const result = await revealSource(
        { requestId: sourceRequest.requestId, locator: resolved.locator },
        {
          editor: info.editor,
          body,
          sourceHash: snapshot.hash,
          isCurrent: current,
          mayFocus: () => sourceMayFocus(sourceRequest, sourceOwner),
        },
      );
      finish(result === 'revealed' && resolved.status === 'relocated' ? 'relocated' : result);
    })().catch(() => finish('unavailable'));
    return () => {
      cancelled = true;
    };
  }, [
    sourceRequest,
    sourceOwner,
    path,
    vaultPath,
    titleOwner,
    sourceDraft,
    bodyVisible,
    selectedTarget,
  ]);

  const captureMention = () => {
    const at = ready.current;
    const target = documentOwner.current;
    const was = base.current;
    if (!sourceRequest || !at || !target || !was || at.path !== path || !vaultPath) return null;
    const currentSource = captureSourceAction(path, sourceOwner, sourceRequest.requestId);
    const currentLife = startRecoveryLoad();
    const generation = target.snapshot().generation;
    const epoch = reconcileEpoch.current;
    const current = () => {
      const state = target.snapshot();
      return (
        mounted.current &&
        currentLife() &&
        currentSource() &&
        ready.current === at &&
        documentOwner.current === target &&
        target.key.vaultId === vaultPath &&
        target.key.path === path &&
        pathRef.current === path &&
        vaultRef.current === vaultPath &&
        base.current === was &&
        reconcileEpoch.current === epoch &&
        !reconciling.current &&
        externalPending.current === 0 &&
        choicesRef.current.length === 0 &&
        !switching.current &&
        modeRef.current === 'rich' &&
        bodyVisibleRef.current !== false &&
        !isLocked() &&
        lossyRef.current === null &&
        !target.recoveryBusy() &&
        !target.recoveryRetired() &&
        state.generation === generation &&
        state.acknowledgedGeneration === generation &&
        state.inFlightGeneration === null &&
        state.failure === null &&
        !state.reconcileRequired &&
        Object.keys(state.childDrafts ?? {}).length === 0 &&
        at.info.serialize() === was.canon
      );
    };
    return current() ? { editor: at.info.editor, stillCurrent: current } : null;
  };

  const frame = (content: import('react').ReactNode, loading = false) =>
    pageTitle === undefined ? (
      content
    ) : (
      <div className={compact ? 'cerebro-editor-compact' : undefined}>
        <div
          className="cb-page-chrome-parking"
          ref={(node) => {
            if (node !== null && !chromeHost.isConnected) node.appendChild(chromeHost);
          }}
        />
        {createPortal(
          <>
            {loading ? (
              <h1 className="cb-page-title-fallback">{pageTitle}</h1>
            ) : mode === 'source' ? (
              <h1 className="cb-page-title-fallback">
                {(() => {
                  const lines = sourceDraft.split(/\r\n|\r|\n/);
                  const index = firstH1LineIndex(sourceDraft);
                  return index < 0 ? pageTitle : lines[index].replace(/^#\s+/, '');
                })()}
              </h1>
            ) : (
              titleOwner !== null &&
              titleOwner.path === loaded?.path &&
              titleOwner.gen === loaded.gen && (
                <OwnedPageTitle
                  owner={titleOwner.info}
                  title={pageTitle}
                  bodyVisible={bodyVisible !== false}
                  settleRef={titleDraftRef}
                  readOnly={readOnly || !nativeEditable || (lossy !== null && !unlocked)}
                  onRecoveryDraft={captureTitleDraft}
                  applyRecoveryDraft={applyTitleDraft}
                />
              )
            )}
            {pageChrome}
            {bodyVisible !== false && <div data-testid="page-body-start" aria-hidden="true" />}
          </>,
          chromeHost,
        )}
        {content}
      </div>
    );
  if (failed) {
    return frame(
      <p
        role={selectedTarget === undefined ? undefined : 'alert'}
        className={
          selectedTarget === undefined ? 'm-0 px-1 py-2 text-sm text-n-500' : 'section-unavailable'
        }
      >
        This page couldn't be loaded.
      </p>,
      true,
    );
  }
  if (loaded === null || loaded.path !== path || loaded.selectedIdentity !== identity) {
    return frame(
      <StateMessage state="loading" title="Loading page…" compact testId="note-body-loading" />,
      true,
    );
  }

  const locked = readOnly || !nativeEditable || (lossy !== null && !unlocked);
  const bodyUnavailable =
    selectedTarget !== undefined &&
    rereadFailure !== null &&
    rereadFailure.owner === documentOwner.current &&
    rereadFailure.editor === ready.current?.info &&
    rereadFailure.opening === getVaultOpening();
  const workspaceUnavailable =
    selectedTarget !== undefined &&
    scanObservation != null &&
    scanObservation.vault === vaultPath &&
    scanObservation.opening === getVaultOpening() &&
    scanObservation.outcome === 'unavailable';

  const externalBodyObserved =
    selectedTarget !== undefined &&
    selectedBodyPresentation !== null &&
    selectedBodyPresentation.vault === vaultPath &&
    selectedBodyPresentation.path === path &&
    selectedBodyPresentation.identity === identity &&
    selectedBodyPresentation.opening === getVaultOpening() &&
    selectedBodyPresentation.observedBodyHash !== selectedBodyPresentation.canonicalBodyHash;

  // This proves the current presentation locally; native admission still
  // reads the actual displaced body at dispatch under human LWW.
  const selectedCleanSave = () => {
    const target = documentOwner.current;
    const at = ready.current;
    const observed = selectedBodyPresentationRef.current;
    const selected = selectedRef.current;
    const vault = vaultRef.current;
    const workspace = useVaultStore.getState();
    const entry = workspace.entries.find((candidate) => candidate.path === pathRef.current);
    if (
      !mounted.current ||
      target === null ||
      at === null ||
      observed === null ||
      selected === undefined ||
      vault === null ||
      observed.vault !== vault ||
      observed.path !== pathRef.current ||
      observed.identity !== selectedIdentity(selected) ||
      observed.opening !== getVaultOpening() ||
      at.path !== pathRef.current ||
      !sameSelectedTarget(target.selectedTarget, selected) ||
      entry?.authority?.kind !== 'sqlite_metadata' ||
      !sameSelectedTarget(entry.authority, selected) ||
      workspace.vaultPath !== vault ||
      workspace.entriesVault !== vault ||
      workspace.status !== 'ready' ||
      observed.observedBodyHash === observed.canonicalBodyHash ||
      entry.authority.bodyHash === observed.observedBodyHash ||
      isLocked() ||
      bodyUnavailable ||
      composing.current ||
      at.info.editor.prosemirrorView?.composing === true ||
      switching.current ||
      externalPending.current > 0 ||
      reconciling.current !== null ||
      choicesRef.current.length > 0 ||
      target.recoveryBusy()
    )
      return null;
    const state = target.snapshot();
    const was = state.mergeBase;
    if (
      state.selectedSave !== undefined ||
      state.failure !== null ||
      state.reconcileRequired === true ||
      state.generation !== state.acknowledgedGeneration ||
      Object.keys(state.childDrafts ?? {}).length > 0 ||
      state.bodyFormat !== modeRef.current ||
      !was ||
      sha256Hex(was.raw) !== observed.observedBodyHash ||
      state.latestDraft !== (modeRef.current === 'source' ? was.raw : was.canon)
    )
      return null;
    try {
      if (modeRef.current === 'rich' && at.info.serialize() !== was.canon) return null;
    } catch {
      return null;
    }
    return { target, raw: was.raw, generation: state.generation };
  };
  const saveSelectedText = () => {
    const intent = selectedCleanSave();
    if (intent === null) return;
    const currentOpening = startRecoveryLoad();
    const opening = getVaultOpening();
    const editor = ready.current;
    void intent.target.saveSelectedText(intent.raw, intent.generation).then((result) => {
      if (
        result.kind === 'failed' &&
        currentOpening() &&
        getVaultOpening() === opening &&
        mounted.current &&
        documentOwner.current === intent.target &&
        ready.current === editor &&
        vaultRef.current === intent.target.key.vaultId &&
        pathRef.current === intent.target.key.path &&
        sameSelectedTarget(selectedRef.current, intent.target.selectedTarget)
      )
        toast(
          `Couldn't save page: ${
            result.code.startsWith('recovery_required:')
              ? 'the recovery copy could not be stored. Retry save or choose to save without a copy.'
              : refusalText(result.code)
          }`,
        );
    });
  };

  return frame(
    <div
      ref={sourceRoot}
      onCompositionStartCapture={() => {
        composing.current = true;
      }}
      onCompositionEndCapture={() => {
        composing.current = false;
      }}
      className={`flex min-h-0 flex-1 flex-col${mode === 'source' ? ' cb-source-mode' : ''}${compact ? ' cerebro-editor-compact' : ''}${
        sections ? ' cerebro-editor-sections' : ''
      }`}
    >
      {externalBodyObserved && (
        <div role="status" className="px-1 py-2 text-sm text-n-600">
          External changes were observed. This page is not yet reconciled with this workspace.
          <Button
            size="sm"
            variant="ghost"
            disabled={selectedCleanSave() === null}
            onClick={saveSelectedText}
          >
            Save this text
          </Button>
        </div>
      )}
      {workspaceUnavailable && (
        <div role="alert" className="section-unavailable">
          Workspace refresh unavailable. Some pages and properties may be out of date.
          <Button size="sm" variant="ghost" onClick={() => void rescan()}>
            Retry refresh
          </Button>
        </div>
      )}
      {bodyUnavailable && (
        <div role="alert" className="section-unavailable">
          Page body unavailable. Your draft is kept.
          <Button size="sm" variant="ghost" onClick={requestReconcile}>
            Retry read
          </Button>
        </div>
      )}
      {selectedTarget !== undefined && !nativeEditable && (
        <div role="status" className="px-1 py-2 text-sm text-n-600">
          {nativeReadOnlyReason ?? 'This selected page is currently read-only.'}
        </div>
      )}
      {sourceRequest && (
        <div
          role="status"
          data-testid="source-reveal-status"
          className="flex items-center gap-2 py-2 text-sm text-n-600"
        >
          <span>
            {sourceRequest.status === 'revealed'
              ? 'Source passage revealed.'
              : sourceRequest.status === 'relocated'
                ? 'Source passage relocated in the updated page.'
                : sourceRequest.status === 'changed'
                  ? 'This source has changed. The recorded passage could not be selected.'
                  : sourceRequest.status === 'unsupported'
                    ? 'Source context opened. This content does not support exact passage reveal.'
                    : sourceRequest.status === 'cancelled'
                      ? 'Source context opened. Reveal cancelled because focus moved.'
                      : sourceRequest.status === 'unavailable'
                        ? 'This source is unavailable.'
                        : 'Finding the recorded source…'}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const outcome = await returnToSourceOrigin(sourceRequest.requestId);
              setReturnUnavailable(outcome === 'origin_unavailable');
            }}
          >
            {sourceRequest.origin.kind === 'QuickOpen' ? 'Return to results' : 'Return to origin'}
          </Button>
          {returnUnavailable && <span>The origin is no longer available.</span>}
          {sourceRequest.mentionLink && (
            <MentionLinkAction
              key={sourceRequest.requestId}
              request={sourceRequest}
              owner={sourceOwner}
              capture={captureMention}
            />
          )}
        </div>
      )}
      <div role="group" aria-label="Page presentation" className="cb-page-presentation">
        <Button
          size="sm"
          variant={mode === 'rich' ? 'secondary' : 'ghost'}
          aria-pressed={mode === 'rich'}
          onClick={() => void switchMode('rich')}
        >
          Rich text
        </Button>
        <Button
          size="sm"
          variant={mode === 'source' ? 'secondary' : 'ghost'}
          aria-pressed={mode === 'source'}
          disabled={
            isKnowledgePath(path) ||
            titleOwner?.path !== loaded.path ||
            titleOwner.gen !== loaded.gen
          }
          onClick={() => void switchMode('source')}
        >
          Source
        </Button>
      </div>
      {modeError && (
        <div role="alert">
          {modeError}
          {mode === 'source' && modeError.includes('cannot') && (
            <button type="button" onClick={() => void switchMode('rich', true)}>
              Adopt rich text (content will change)
            </button>
          )}
        </div>
      )}
      <MergeChoices
        choices={choices}
        onPick={pick}
        description={
          selectedChoice.current === null
            ? undefined
            : 'The earlier save could not be confirmed. Compare your draft with the current page before saving again.'
        }
      />
      {documentOwner.current &&
        documentOwner.current.key.vaultId === vaultPath &&
        documentOwner.current.key.path === path && (
          <RecoverySaveStatus owner={documentOwner.current} />
        )}
      {saveFailure && (
        <div role="alert">
          This page has unsaved changes.{' '}
          <button
            type="button"
            onClick={() => {
              const at = ready.current;
              const vault = vaultRef.current;
              const target = recoveryCapture.owner();
              if (at !== null && vault !== null && target !== null) {
                try {
                  titleDraftRef.current?.();
                  settleSheetDrafts(at.info.editor);
                  void land({
                    target,
                    vault,
                    path: at.path,
                    markdown:
                      modeRef.current === 'source'
                        ? (documentOwner.current?.snapshot().latestDraft ?? '')
                        : at.info.serialize(),
                  });
                } catch {
                  toast('Resolve the unsaved sheet cell before saving this page.');
                }
              }
            }}
          >
            Retry save
          </button>
        </div>
      )}
      {mode === 'rich' && lossy !== null && !readOnly && (
        <div
          role="alert"
          data-testid="lossy-import-banner"
          className="mx-1 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warn-500 bg-warn-50 px-3 py-2 text-sm text-warn-700"
        >
          <span className="min-w-0 flex-1">
            {locked ? LOSSY_COPY[lossy].locked : LOSSY_COPY[lossy].unlocked}
          </span>
          {locked && nativeEditable && (
            <button
              type="button"
              onClick={() => setUnlocked(true)}
              className="flex-none rounded-md border border-warn-500 bg-transparent px-2 py-0.5 text-xs font-medium text-warn-700 hover:bg-warn-500 hover:text-n-0"
            >
              {LOSSY_COPY[lossy].button}
            </button>
          )}
        </div>
      )}
      {/* The path the body was LOADED for, the one its saves target too: what
          a chip reads about its own note — a citation's number comes from the
          note's frontmatter `sources` (M51.5) — is about the file on screen. */}
      <NotePathContext.Provider value={loaded.path}>
        <RecoveryBufferContext.Provider value={recoveryCapture}>
          <LazyMarkdownEditor
            // A remount (`gen`) takes the file whole; every other outside write
            // lands in place through `applyExternal`.
            key={`${loaded.path}#${loaded.gen}`}
            markdown={loaded.body}
            readOnly={locked || mode === 'source'}
            onChange={saveOwner}
            onDraft={captureBodyDraft}
            onBeginSave={beginBodySave}
            getSaveDraft={bodySaveDraft}
            onReady={(info: EditorReadyInfo) => {
              if (loaded.selectedIdentity !== selectedIdentity(selectedRef.current)) return;
              if (vaultPath !== null) {
                const target = acquireOwner(vaultPath, loaded.path, info.loadedAs);
                documentOwner.current = target;
                recoveryCapture.bind(target);
                if (!loaded.restored && modeRef.current === 'source')
                  target.present(loaded.body, 'source');
                stopOwner.current?.();
                let observedUnknownKey: string | undefined;
                const update = () => {
                  if (
                    !mounted.current ||
                    documentOwner.current !== target ||
                    pathRef.current !== target.key.path ||
                    !sameSelectedTarget(selectedRef.current, target.selectedTarget)
                  )
                    return;
                  const state = target.snapshot();
                  if (state.bodyFormat === 'source') setSourceDraft(state.latestDraft);
                  if (
                    reconciling.current === null &&
                    state.inFlightGeneration === null &&
                    state.mergeBase
                  )
                    base.current = state.mergeBase;
                  setSaveFailure(state.failure !== null);
                  if (
                    state.selectedSave?.status === 'reconcile' &&
                    observedUnknownKey !== state.selectedSave.requestKey
                  ) {
                    observedUnknownKey = state.selectedSave.requestKey;
                    queueMicrotask(() => {
                      if (
                        mounted.current &&
                        documentOwner.current === target &&
                        sameSelectedTarget(selectedRef.current, target.selectedTarget)
                      )
                        requestReconcile();
                    });
                  }
                  // The owner drives status. A presentation-only rich event
                  // may serialize unchanged bytes and creates no generation.
                  emitSaveState(
                    state.inFlightGeneration !== null
                      ? 'saving'
                      : state.failure !== null
                        ? 'failed'
                        : state.generation > state.acknowledgedGeneration ||
                            Object.keys(state.childDrafts ?? {}).length > 0
                          ? 'dirty'
                          : state.generation > 0
                            ? 'saved'
                            : 'idle',
                  );
                };
                stopOwner.current = target.subscribe(update);
                stopParticipant.current?.();
                bindSheetDrafts(
                  info.editor,
                  target,
                  () => info.sheetSources(),
                  loaded.diskBody === target.snapshot().mergeBase?.raw
                    ? null
                    : info.sheetSources(loaded.diskBody),
                );
                let attached = true;
                const unregister = registerSaveParticipant({
                  identity: target,
                  key: target.key,
                  snapshot: () => target.snapshot(),
                  prepare: () => {
                    if (!attached) return;
                    titleDraftRef.current?.();
                    settleSheetDrafts(info.editor);
                  },
                  blocked: () => {
                    if (
                      Object.keys(target.snapshot().childDrafts ?? {}).length > 0 ||
                      (attached && choicesRef.current.length > 0)
                    )
                      return 'choice';
                    if (
                      switching.current ||
                      target.snapshot().reconcileRequired === true ||
                      (attached && (externalPending.current > 0 || reconciling.current !== null))
                    )
                      return 'reconcile';
                    return null;
                  },
                  flush: async () => {
                    const beforeFailure = target.snapshot().failure;
                    if (attached) await info.flushPendingSave();
                    const state = target.snapshot();
                    // A write that just refused is reported once; explicit Retry
                    // can reattempt an older failure without an additional edit.
                    if (state.failure !== null && state.failure !== beforeFailure)
                      return state.failure;
                    const result = await target.flush();
                    if (result.kind === 'failed')
                      toast(
                        `Couldn't save page: ${result.code.startsWith('recovery_required:') ? 'the recovery copy could not be stored. Retry save or choose to save without a copy.' : refusalText(result.code)}`,
                      );
                    return result;
                  },
                });
                stopParticipant.current = () => {
                  detachSheetDrafts(info.editor);
                  attached = false;
                  unregister();
                };
                update();
              }
              cancelRef.current = info.cancelPendingSave;
              lossyRef.current = info.lossyCause;
              setLossy(info.lossyCause);
              ready.current = { path: loaded.path, info };
              setTitleOwner({ path: loaded.path, gen: loaded.gen, info });
              const target = documentOwner.current;
              if (target !== null) {
                const state = target.snapshot();
                if (
                  state.reconcileRequired === true &&
                  state.generation > state.acknowledgedGeneration &&
                  state.failure === null
                )
                  owed.current = true;
                if (!loaded.restored && target.snapshot().generation === 0)
                  target.setMergeBase({
                    raw: loaded.diskBody,
                    canon: modeRef.current === 'source' ? loaded.body : info.loadedAs,
                  });
                base.current = target.snapshot().mergeBase ?? {
                  raw: loaded.diskBody,
                  canon: info.loadedAs,
                };
                if (
                  loaded.restored &&
                  (loaded.diskBody !== base.current.raw ||
                    target.snapshot().reconcileRequired === true)
                )
                  missed.current = true;
              } else base.current = { raw: loaded.diskBody, canon: info.loadedAs };
              onReady?.(info);
              if (missed.current) {
                missed.current = false;
                requestReconcile();
              }
            }}
            autoFocus={autoFocus}
            debounceMs={debounceMs}
            pageChromeHost={chromeHost}
            pageTitle={pageTitle}
            bodyVisible={mode === 'source' ? false : bodyVisible}
          />
          {mode === 'source' && bodyVisible !== false && (
            <SourceBodyEditor
              raw={sourceDraft}
              readOnly={readOnly || !nativeEditable}
              onError={toast}
              onChange={(raw) => {
                const target = recoveryCapture.owner();
                if (target === null) return;
                target.edit(raw, 'source');
                setSourceDraft(raw);
                ready.current?.info.schedulePendingSave();
              }}
            />
          )}
        </RecoveryBufferContext.Provider>
      </NotePathContext.Provider>
    </div>,
  );
}
