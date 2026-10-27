import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import {
  creationDraftKey,
  type CreationContext,
  type CreationDestination,
} from '@/engine/creationDestination';
import { deepEqual } from '@/lib/deepEqual';
import {
  claimCreationDraft,
  discardCreationDraft,
  moveCreationDraft,
  readCreationDraft,
  readCreationSubmission,
  releaseCreationDraft,
  saveCreationDraft,
  subscribeCreationDrafts,
  type CreationDraft,
  type CreationSubmission,
} from '@/stores/creationDraftStore';
import { useVaultStore } from '@/stores/vaultStore';
import { submitCreationDraft } from './creationSubmission';

export function useCreationSession(
  origin: CreationContext,
  defaults: (context: CreationContext) => { title: string; values: Record<string, unknown> },
  onSuccess: (submission: CreationSubmission) => void,
) {
  const owner = useId();
  const pendingSnapshot = (ctx: CreationContext) => {
    const submission = readCreationSubmission(ctx);
    return submission?.state === 'pending' ? submission.snapshot : null;
  };
  const [context, setContext] = useState(() => structuredClone(origin));
  const blank = (ctx: CreationContext): CreationDraft => ({
    context: ctx,
    revision:
      Math.max(
        readCreationDraft(ctx)?.revision ?? 0,
        readCreationSubmission(ctx)?.draftRevision ?? 0,
      ) + 1,
    ...defaults(ctx),
    createMore: false,
    fieldErrors: {},
    formError: null,
  });
  const [draft, setDraft] = useState(
    () => readCreationDraft(context) ?? pendingSnapshot(context) ?? blank(context),
  );
  const current = useRef(draft);
  const [recovering, setRecovering] = useState(
    () =>
      readCreationDraft(context) !== null || readCreationSubmission(context)?.state === 'pending',
  );
  const [claimed, setClaimed] = useState(false);
  const [transfer, setTransfer] = useState<CreationContext | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const transferRef = useRef<CreationContext | null>(null);
  const submission = useSyncExternalStore(subscribeCreationDrafts, () =>
    readCreationSubmission(context),
  );
  const saved = useSyncExternalStore(subscribeCreationDrafts, () => readCreationDraft(context));
  const ownSubmission = useRef<string | null>(null);
  // Every mount observes the operation it recovered; navigation remains with
  // the mount that started it. Acknowledged input must never become another create.
  const observedSubmission = useRef(
    pendingSnapshot(context) === null ? null : (readCreationSubmission(context)?.id ?? null),
  );
  const success = useRef(onSuccess);
  success.current = onSuccess;
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const pending = submission?.state === 'pending';
  const baselines = useRef(
    new Map([[creationDraftKey(origin), structuredClone(defaults(origin))]]),
  );
  const update = (
    change: Partial<CreationDraft> | ((previous: CreationDraft) => Partial<CreationDraft>),
  ) => {
    if (!claimCreationDraft(current.current.context, owner)) return current.current;
    const patch = typeof change === 'function' ? change(current.current) : change;
    if (
      Object.entries(patch).every(([key, value]) =>
        deepEqual(current.current[key as keyof CreationDraft], value),
      )
    )
      return current.current;
    const next = { ...current.current, ...patch, revision: current.current.revision + 1 };
    current.current = next;
    setDraft(next);
    const baseline =
      baselines.current.get(creationDraftKey(next.context)) ?? defaultsRef.current(next.context);
    if (
      next.title !== baseline.title ||
      !deepEqual(next.values, baseline.values) ||
      Object.entries(next.scalarDrafts ?? {}).some(
        ([field, draft]) => draft.text !== String(next.values[field] ?? ''),
      ) ||
      pending
    )
      saveCreationDraft(next);
    else {
      const previous = readCreationDraft(next.context);
      if (previous !== null) discardCreationDraft(next.context, previous.revision);
    }
    return next;
  };
  useEffect(() => {
    setClaimed(claimCreationDraft(context, owner));
    return () => releaseCreationDraft(context, owner);
  }, [context, owner]);
  useEffect(() => {
    if (submission?.state === 'pending') {
      // A denied claimant can already be mounted when the owning composer
      // starts a write. Observe that live operation, not only mount-time state.
      observedSubmission.current = submission.id;
      if (ownSubmission.current !== submission.id) {
        const latest = readCreationDraft(context) ?? submission.snapshot;
        current.current = latest;
        setDraft(latest);
      }
      return;
    }
    if (submission?.id !== observedSubmission.current) return;
    const mayNavigate = submission.id === ownSubmission.current;
    observedSubmission.current = null;
    ownSubmission.current = null;
    if (useVaultStore.getState().vaultPath !== context.vault) return;
    const latest = readCreationDraft(context);
    if (latest !== null && latest.revision !== submission.draftRevision) {
      current.current = latest;
      setDraft(latest);
      return;
    }
    if (current.current.revision !== submission.draftRevision) return;
    if (submission.state === 'failed') {
      if (latest !== null) {
        current.current = latest;
        setDraft(latest);
      }
      return;
    }
    const next = {
      ...current.current,
      title: '',
      revision: current.current.revision + 1,
      scalarDrafts: {},
      formError: null,
      fieldErrors: {},
    };
    current.current = next;
    setDraft(next);
    setRecovering(false);
    if (mayNavigate) success.current(submission);
  }, [submission, context]);
  const activate = (ctx: CreationContext) => {
    if (!baselines.current.has(creationDraftKey(ctx)))
      baselines.current.set(creationDraftKey(ctx), structuredClone(defaultsRef.current(ctx)));
    releaseCreationDraft(context, owner);
    const next = readCreationDraft(ctx) ?? pendingSnapshot(ctx) ?? blank(ctx);
    current.current = next;
    setDraft(next);
    setContext(ctx);
    setClaimed(claimCreationDraft(ctx, owner));
    setRecovering(
      readCreationDraft(ctx) !== null || readCreationSubmission(ctx)?.state === 'pending',
    );
    transferRef.current = null;
    setTransfer(null);
    ownSubmission.current = null;
    observedSubmission.current =
      pendingSnapshot(ctx) === null ? null : (readCreationSubmission(ctx)?.id ?? null);
  };
  return {
    context,
    draft,
    saved,
    pending,
    recovering,
    claimed,
    transfer,
    transferError,
    update,
    resume: () => {
      if (claimCreationDraft(context, owner)) {
        setClaimed(true);
        // Ownership may have changed since this recovery card rendered. Read
        // the live key; settled submissions and old local input are never drafts.
        const liveSubmission = readCreationSubmission(context);
        const next = readCreationDraft(context) ?? pendingSnapshot(context) ?? blank(context);
        observedSubmission.current = liveSubmission?.state === 'pending' ? liveSubmission.id : null;
        ownSubmission.current = null;
        current.current = next;
        setDraft(next);
        setRecovering(false);
      }
    },
    discard: () => {
      if (!claimCreationDraft(context, owner)) return;
      const previous = readCreationDraft(context);
      if (previous !== null && discardCreationDraft(context, previous.revision)) {
        const next = blank(context);
        current.current = next;
        setDraft(next);
        setRecovering(false);
      }
    },
    changeDestination: (destination: CreationDestination) => {
      setTransferError(null);
      const target = { ...context, destination };
      if (creationDraftKey(target) === creationDraftKey(context) || pending) return;
      if (readCreationDraft(context) !== null) {
        transferRef.current = target;
        setTransfer(target);
      } else activate(target);
    },
    leaveAndStart: () => {
      if (transfer !== null) activate(transfer);
    },
    cancelTransfer: () => {
      transferRef.current = null;
      setTransfer(null);
    },
    move: () => {
      if (transfer !== null && moveCreationDraft(context, transfer, current.current.revision)) {
        activate(transfer);
        setRecovering(false);
      } else
        setTransferError(
          'This destination already has a draft or a pending creation. Leave this draft here to inspect and Resume that destination.',
        );
    },
    submit: () => {
      if (
        readCreationSubmission(current.current.context)?.state === 'pending' ||
        !claimed ||
        recovering ||
        pending ||
        transferRef.current !== null ||
        context.vault !== useVaultStore.getState().vaultPath
      )
        return;
      if (current.current.title.trim() === '') {
        update({ formError: 'Give it a title' });
        return;
      }
      const next = { ...current.current, formError: null, revision: current.current.revision + 1 };
      current.current = next;
      setDraft(next);
      saveCreationDraft(next);
      const result = submitCreationDraft(context, next.revision);
      if (result.kind === 'started') {
        ownSubmission.current = result.submission.id;
        observedSubmission.current = result.submission.id;
      }
    },
  };
}
