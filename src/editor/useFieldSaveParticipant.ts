import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { documentAdmission, subscribeDocumentAdmission } from './documentAdmission';
import type { DocumentKey } from './documentOwner';
import {
  FieldSaveParticipant,
  retainedField,
  type FieldValidator,
  type FieldWriter,
} from './fieldSaveParticipant';
import { registerSaveParticipant } from './openPages';
const empty = {
  latestDraft: '',
  generation: 0,
  acknowledgedGeneration: 0,
  inFlightGeneration: null,
  failure: null,
};
const emptySnapshot = () => empty;
const noSubscription = () => () => {};
const mounts = new WeakMap<FieldSaveParticipant, { count: number; release: () => void }>();
export function useFieldSaveParticipant(
  key: DocumentKey,
  initial: string,
  validate: FieldValidator,
  write: FieldWriter,
) {
  const admission = useSyncExternalStore(subscribeDocumentAdmission, () =>
    documentAdmission(key, retainedField(key)),
  );
  // An attachment keeps its exact owner even while a landed move changes
  // registry keys before the replacement presentation commits.
  const [owner, setOwner] = useState<FieldSaveParticipant | null>(() =>
    admission.kind === 'deferred'
      ? null
      : (retainedField(key) ?? new FieldSaveParticipant(key, initial, validate, write)),
  );
  useLayoutEffect(() => {
    if (owner === null && admission.kind === 'ready')
      setOwner(retainedField(key) ?? new FieldSaveParticipant(key, initial, validate, write));
  }, [owner, admission, key, initial, validate, write]);
  const attachedPath = key.path;
  useLayoutEffect(() => {
    owner?.configure(validate, write, attachedPath);
  }, [owner, validate, write, attachedPath]);
  useLayoutEffect(() => {
    if (owner === null) return;
    const registration = mounts.get(owner) ?? { count: 0, release: registerSaveParticipant(owner) };
    mounts.set(owner, registration);
    registration.count += 1;
    return () => {
      registration.count -= 1;
      if (registration.count === 0) {
        registration.release();
        mounts.delete(owner);
      }
    };
  }, [owner]);
  const state = useSyncExternalStore(
    owner?.subscribe ?? noSubscription,
    owner?.snapshot ?? emptySnapshot,
  );
  return owner === null
    ? { kind: 'deferred' as const, message: 'Page is moving. Wait for it to finish.' }
    : { kind: 'ready' as const, owner, state, error: owner.message() };
}

export const fieldPresentationCount = (owner: FieldSaveParticipant): number =>
  mounts.get(owner)?.count ?? 0;
