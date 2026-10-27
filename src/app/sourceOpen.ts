import { isRecordEntry } from '@/engine/typeCatalog';
import { isKnowledgePath } from '@/engine/okf';
import { reserveLeaveIntent, finishLeaveIntent, saveBeforeAction } from './leaveGuard';
import { resolveSource } from '@/lib/ipc';
import { holderOf } from '@/engine/panes';
import { useOpenPath } from './useOpenPath';
import { useVaultStore } from '@/stores/vaultStore';
import { useUiStore } from '@/stores/uiStore';
import type { SourceLocator } from '@/engine/sourceLocation';
import type { MentionLinkOutcome } from '@/editor/mentionLink';
import type { Category, Level } from './palette/model';
import { layoutOf, useNavStore, type PaneId, type NavOutcome } from '@/stores/navStore';
export interface QuickOpenSnapshot {
  query: string;
  category: Category;
  level: Level;
  expandedFor: string | null;
  activeRowKey: string | null;
  scrollTop: number;
}
export type SourceReturnOrigin =
  | {
      kind: 'Visit';
      vaultId: string;
      pane: PaneId;
      visitId: string;
      peek?: { path: string; siblings: string[] };
    }
  | {
      kind: 'QuickOpen';
      vaultId: string;
      pane: PaneId;
      visitId: string;
      snapshot: QuickOpenSnapshot;
    }
  | {
      kind: 'Conversation';
      vaultId: string;
      threadId: string;
      turnId: string;
      presentation: 'floating' | 'panel' | 'canvas';
      scrollAnchor: string | null;
    };
export interface SourceOpenRequest {
  requestId: string;
  locator: SourceLocator;
  origin: SourceReturnOrigin;
  intent: 'default' | 'full_page' | 'beside';
  /** Data from an explicit mention action; navigation itself never writes. */
  mentionLink?: {
    occurrenceId: string;
    targetPath: string;
    targetHash: string;
    status?: 'pending' | MentionLinkOutcome;
  };
}
export interface SourceOpenRecord extends SourceOpenRequest {
  status?: SourceRevealStatus;
  focusEpoch: number;
  openedVaultPath: string;
  vaultEpoch: number;
}

export function sourceVisitOrigin(
  vaultId: string,
  pane = useNavStore.getState().active,
): Extract<SourceReturnOrigin, { kind: 'Visit' }> {
  const nav = useNavStore.getState();
  let visitId = nav.readEntryState<string>('source.visitId', pane);
  if (!visitId) {
    visitId = crypto.randomUUID();
    nav.setEntryState('source.visitId', visitId, pane);
  }
  const ui = useUiStore.getState();
  const peek =
    ui.detailPath !== null &&
    (ui.detailPane === pane || (ui.detailPane === null && nav.active === pane))
      ? { path: ui.detailPath, siblings: [...ui.detailSiblings] }
      : undefined;
  return { kind: 'Visit', vaultId, pane, visitId, ...(peek ? { peek } : {}) };
}
export function sourceRequestFor(
  path: string,
  owner: PaneId | 'peek',
): SourceOpenRecord | undefined {
  const nav = useNavStore.getState();
  const request =
    owner === 'peek'
      ? nav.sourcePeek
      : nav.readEntryState<SourceOpenRecord>('source.request', owner);
  return request?.locator.path === path &&
    request.openedVaultPath === useVaultStore.getState().vaultPath &&
    request.vaultEpoch === vaultEpoch
    ? request
    : undefined;
}
export function finishSourceRequest(
  path: string,
  owner: PaneId | 'peek',
  requestId: string,
  status: SourceRevealStatus,
): void {
  const request = sourceRequestFor(path, owner);
  if (!request || request.requestId !== requestId || request.status !== undefined) return;
  const next = { ...request, status };
  if (owner === 'peek') useNavStore.setState({ sourcePeek: next });
  else useNavStore.getState().setEntryState('source.request', next, owner);
}

/** Settle the original request even after its view leaves. The captured vault
 * epoch, owner and request identity never authorize another visit's state. */
export function finishMentionLink(
  expected: SourceOpenRecord,
  owner: PaneId | 'peek',
  status: 'pending' | MentionLinkOutcome,
): void {
  if (
    !expected.mentionLink ||
    expected.openedVaultPath !== useVaultStore.getState().vaultPath ||
    expected.vaultEpoch !== vaultEpoch
  )
    return;
  const settle = (request: SourceOpenRecord | null | undefined): SourceOpenRecord | null => {
    if (
      !request?.mentionLink ||
      request.requestId !== expected.requestId ||
      request.openedVaultPath !== expected.openedVaultPath ||
      request.vaultEpoch !== expected.vaultEpoch ||
      request.locator.vaultId !== expected.locator.vaultId ||
      request.locator.path !== expected.locator.path ||
      request.locator.sourceHash !== expected.locator.sourceHash ||
      request.mentionLink.occurrenceId !== expected.mentionLink?.occurrenceId ||
      request.mentionLink.targetPath !== expected.mentionLink?.targetPath ||
      request.mentionLink.targetHash !== expected.mentionLink?.targetHash ||
      (request.mentionLink.status !== undefined && request.mentionLink.status !== 'pending')
    )
      return null;
    return { ...request, mentionLink: { ...request.mentionLink, status } };
  };
  useNavStore.setState((nav) => {
    if (owner === 'peek') {
      const next = settle(nav.sourcePeek);
      return next ? { sourcePeek: next } : nav;
    }
    const ownedHistory = owner === nav.active ? nav.history : nav.stashed[owner]?.history;
    if (!ownedHistory) return nav;
    let changed = false;
    const history = ownedHistory.map((slot) => {
      const next = settle(slot.state?.['source.request'] as SourceOpenRecord | undefined);
      if (!next) return slot;
      changed = true;
      return { ...slot, state: { ...slot.state, 'source.request': next } };
    });
    if (!changed) return nav;
    if (owner === nav.active) return { history };
    const pane = nav.stashed[owner];
    return pane ? { stashed: { ...nav.stashed, [owner]: { ...pane, history } } } : nav;
  });
}
export type SourceRevealStatus =
  'revealed' | 'relocated' | 'changed' | 'unsupported' | 'cancelled' | 'unavailable';

export function useSourceNavigation() {
  // These hooks belong to the render, never an event handler.
  const openDefault = useOpenPath();
  const openFull = useOpenPath('navigate', { fullPage: true });
  const openSource = async (request: SourceOpenRequest): Promise<NavOutcome> => {
    const nav = useNavStore.getState();
    const vault = useVaultStore.getState().vaultPath;
    const epoch = vaultEpoch;
    const generation = ++openGeneration;
    const sourcePane = nav.active;
    const sourceSeq = nav.navSeq;
    const inputEpoch = focusEpoch;
    if (!vault) return { kind: 'unchanged', pane: sourcePane };
    const intent = reserveLeaveIntent(`pane:${sourcePane}`);
    const stillCurrent = () =>
      intent.isCurrent() &&
      generation === openGeneration &&
      epoch === vaultEpoch &&
      sourcePane === useNavStore.getState().active &&
      sourceSeq === useNavStore.getState().navSeq &&
      inputEpoch === focusEpoch;
    try {
      const resolved = await resolveSource(vault, request.locator);
      if (!stillCurrent()) {
        finishLeaveIntent(intent);
        return { kind: 'unchanged', pane: useNavStore.getState().active };
      }
      if (resolved.status === 'unavailable') {
        finishLeaveIntent(intent);
        useUiStore.getState().toast('Source is unavailable.');
        return { kind: 'unchanged', pane: sourcePane };
      }
    } catch {
      finishLeaveIntent(intent);
      useUiStore.getState().toast('Source is unavailable.');
      return { kind: 'unchanged', pane: sourcePane };
    }
    if (!(await saveBeforeAction('all', 'block', stillCurrent))) {
      finishLeaveIntent(intent);
      return { kind: 'unchanged', pane: useNavStore.getState().active };
    }
    finishLeaveIntent(intent);
    if (request.locator.kind === 'property') {
      const entry = useVaultStore
        .getState()
        .entries.find((entry) => entry.path === request.locator.path);
      if (entry && !isRecordEntry(entry)) {
        if (isKnowledgePath(entry.path)) {
          useUiStore.getState().setConceptPanel('details');
          useUiStore.getState().setConceptPanelOpen(true);
        } else {
          useUiStore.getState().setDocPanel('details');
          useUiStore.getState().setDocPanelOpen(true);
        }
      }
    }
    const outcome =
      request.intent === 'default'
        ? openDefault(request.locator.path, { newPane: false })
        : openFull(request.locator.path, { newPane: request.intent === 'beside' });
    const holder = holderOf(layoutOf(useNavStore.getState()), {
      kind: 'doc',
      path: request.locator.path,
    });
    // A guarded asynchronous leave may not yet have opened anything. Never
    // bind its request to an unrelated current page.
    const stored = {
      ...request,
      origin: request.origin,
      focusEpoch,
      openedVaultPath: vault,
      vaultEpoch: epoch,
    };
    if (holder) {
      useNavStore.getState().focusPane(holder.id);
      useNavStore.getState().setEntryState('source.request', stored, holder.id);
    } else if (useUiStore.getState().detailPath === request.locator.path) {
      useNavStore.setState({ sourcePeek: stored });
    } else useUiStore.getState().toast('Source reveal is unavailable on this page.');
    return outcome;
  };
  return { openSource, returnToSourceOrigin };
}
export async function returnToSourceOrigin(
  requestId: string,
): Promise<'restored' | 'origin_unavailable'> {
  const nav = useNavStore.getState();
  const request = [
    nav.sourcePeek,
    ...layoutOf(nav).panes.flatMap((pane) =>
      pane.history.map((slot) => slot.state?.['source.request'] as SourceOpenRecord | undefined),
    ),
  ].find((item) => item?.requestId === requestId);
  const origin = request?.origin;
  if (
    !origin ||
    origin.vaultId !== request?.locator.vaultId ||
    request?.openedVaultPath !== useVaultStore.getState().vaultPath ||
    request.vaultEpoch !== vaultEpoch
  )
    return 'origin_unavailable';
  if (origin.kind === 'Conversation') {
    // M92 owns thread, draft and scroll locally. A missing return owner
    // cannot be reconstructed from cached transcript text.
    return 'origin_unavailable';
  }
  const peek = origin.kind === 'Visit' ? origin.peek : undefined;
  const readable = (path: string) =>
    useVaultStore
      .getState()
      .entries.some((entry) => entry.path === path && !entry.parseError?.startsWith('unreadable:'));
  if (peek && !readable(peek.path)) return 'origin_unavailable';
  const generation = ++openGeneration;
  const current = () =>
    (!peek || readable(peek.path)) &&
    generation === openGeneration &&
    request.vaultEpoch === vaultEpoch &&
    request.openedVaultPath === useVaultStore.getState().vaultPath &&
    [
      useNavStore.getState().sourcePeek,
      ...layoutOf(useNavStore.getState()).panes.flatMap((pane) =>
        pane.history.map((slot) => slot.state?.['source.request'] as SourceOpenRecord | undefined),
      ),
    ].some((item) => item?.requestId === requestId);
  if (!(await nav.restoreVisit(origin.pane, origin.visitId, current))) return 'origin_unavailable';
  if (peek) {
    if (!current()) return 'origin_unavailable';
    const restored = useNavStore.getState();
    useUiStore.getState().setDetailSiblings(peek.siblings.filter(readable), restored.active);
    restored.openPeek(peek.path, { from: restored.active, restore: true });
  }
  if (origin.kind === 'QuickOpen') {
    useNavStore.setState({ quickOpenResume: origin.snapshot });
    useUiStore.getState().setQuickOpen(true);
  }
  return 'restored';
}
// Navigation, input and focus transfers revoke delayed autofocus. Quick Open
// finishes its existing close/focus restoration before starting the request.
let focusEpoch = 0;
let vaultEpoch = 0;
let openGeneration = 0;
useNavStore.subscribe((state, previous) => {
  if (state.active !== previous.active) focusEpoch += 1;
});
useVaultStore.subscribe((state, previous) => {
  if (state.vaultPath !== previous.vaultPath) {
    vaultEpoch += 1;
    openGeneration += 1;
  }
  if (state.vaultPath !== previous.vaultPath || state.entries !== previous.entries)
    useNavStore
      .getState()
      .pruneSourceRequests(state.vaultPath, new Set(state.entries.map((entry) => entry.path)));
});
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    () => {
      focusEpoch += 1;
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    () => {
      focusEpoch += 1;
    },
    true,
  );
  document.addEventListener(
    'beforeinput',
    () => {
      focusEpoch += 1;
    },
    true,
  );
}
export function sourceMayFocus(request: SourceOpenRecord, owner: PaneId | 'peek'): boolean {
  const nav = useNavStore.getState();
  return (
    request.focusEpoch === focusEpoch &&
    (owner === 'peek'
      ? useUiStore.getState().detailPath === request.locator.path
      : nav.active === owner)
  );
}

/** Capture the person's NEW source-side action after its button took focus.
 * The earlier reveal epoch would already be obsolete. The existing epochs
 * also retire focus/vault round trips; no new global listener is needed. */
export function captureSourceAction(
  path: string,
  owner: PaneId | 'peek',
  requestId: string,
): () => boolean {
  const nav = useNavStore.getState();
  const active = nav.active;
  const seq = nav.navSeq;
  const focus = focusEpoch;
  const vault = vaultEpoch;
  const peekPane = useUiStore.getState().detailPane;
  return () => {
    const current = useNavStore.getState();
    const ui = useUiStore.getState();
    return (
      focus === focusEpoch &&
      vault === vaultEpoch &&
      active === current.active &&
      seq === current.navSeq &&
      sourceRequestFor(path, owner)?.requestId === requestId &&
      (owner === 'peek'
        ? ui.detailPath === path && ui.detailPane === peekPane && (peekPane ?? active) === active
        : owner === active)
    );
  };
}
